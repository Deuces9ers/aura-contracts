import assert from "assert";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";

import { chainIds } from "../../hardhat.config";
import { getSigner, waitForTx } from "../utils";
import { config as goerliConfig } from "../deploy/goerli-config";
import { config as arbitrumGoerliConfig } from "../deploy/arbitrumGoerli-config";
import { CanonicalPhaseDeployed, SidechainDeployed } from "scripts/deploySidechain";
import { formatEther } from "ethers/lib/utils";
import { JsonRpcProvider } from "@ethersproject/providers";

const debug = true;

const remoteChainMap = {
    [chainIds.goerli]: chainIds.arbitrumGoerli,
    [chainIds.arbitrum]: chainIds.mainnet,
    [chainIds.arbitrumGoerli]: chainIds.goerli,
    [chainIds.polygon]: chainIds.mainnet,
};

const lzChainIds = {
    [chainIds.mainnet]: 101,
    [chainIds.arbitrum]: 110,
    [chainIds.goerli]: 10121,
    [chainIds.arbitrumGoerli]: 10143,
};

const configs = {
    [chainIds.goerli]: goerliConfig,
    [chainIds.arbitrumGoerli]: arbitrumGoerliConfig,
};

task("sidechain:set-trusted-remote")
    .addParam("wait", "Wait for blocks")
    .addParam("remotechainid", "Remote standard chain ID, eg Eth Mainnet is 1")
    .setAction(async function (tskArgs: TaskArguments, hre: HardhatRuntimeEnvironment) {
        const deployer = await getSigner(hre);

        const localConfig = configs[hre.network.config.chainId];
        assert(localConfig, `Local config for chain ID ${hre.network.config.chainId} not found`);

        const remoteChainId = tskArgs.remotechainid;
        assert(
            Number(remoteChainId) === Number(remoteChainMap[hre.network.config.chainId]),
            `Incorrect remote chain ID ${remoteChainId} !== ${remoteChainMap[hre.network.config.chainId]}`,
        );

        const remoteConfig = configs[remoteChainId];
        assert(remoteConfig, `Remote config for chain ID ${remoteChainId} not found`);

        const remoteLzChainId = lzChainIds[remoteChainId];
        assert(remoteLzChainId, "LZ chain ID not found");

        const local = await localConfig.getSidechain(deployer);
        const remote = await remoteConfig.getSidechain(deployer);

        if ("auraOFT" in local && "coordinator" in remote) {
            // The local chain is the canonical chain
            // Example: we are on mainnet setting the aribtrum coordinator as a trusted remote
            const tx = await local.auraOFT.setTrustedRemoteAddress(remoteLzChainId, remote.coordinator.address);
            await waitForTx(tx, debug, tskArgs.wait);
        } else if ("coordinator" in local && "auraOFT" in remote) {
            // The local chain is one of the sidechains
            // Example: we are on arbitrum setting the mainnet auraOFT as a trusted remote
            const tx = await local.coordinator.setTrustedRemoteAddress(remoteLzChainId, remote.auraOFT.address);
            await waitForTx(tx, debug, tskArgs.wait);
        }
    });

task("sidechain:aura-oft-info")
    .addParam("remotechainid", "Remote standard chain ID (can not be eth mainnet)")
    .setAction(async function (tskArgs: TaskArguments, hre: HardhatRuntimeEnvironment) {
        const remoteNodeUrl = process.env.REMOTE_NODE_URL;
        assert(remoteNodeUrl.length > 0, "REMOTE_NODE_URL not set");
        assert(tskArgs.remotechainid !== 1, "Remote chain ID cannot be 1");

        const deployer = await getSigner(hre);
        const deployerAddress = await deployer.getAddress();

        const localChainId = hre.network.config.chainId;
        const localConfig = configs[localChainId];
        const localLzChainId = lzChainIds[localChainId];
        assert(localConfig, `Local config for chain ID ${hre.network.config.chainId} not found`);
        assert(localLzChainId, "Local LZ chain ID not found");
        assert("getPhase2" in localConfig, "Local config must be eth/goerli config");

        const remoteChainId = tskArgs.remotechainid;
        assert(
            Number(remoteChainId) === Number(remoteChainMap[hre.network.config.chainId]),
            `Incorrect remote chain ID ${remoteChainId} !== ${remoteChainMap[hre.network.config.chainId]}`,
        );

        const remoteConfig = configs[remoteChainId];
        assert(remoteConfig, `Remote config for chain ID ${remoteChainId} not found`);

        const remoteLzChainId = lzChainIds[remoteChainId];
        assert(remoteLzChainId, "Remote LZ chain ID not found");

        const log = (title: string, general?: string[], signer?: string[]) => {
            console.log("===================");
            console.log(title);
            console.log("===================");
            console.log("");
            if (general) {
                console.log("#### General ####");
                general.forEach(s => console.log(s));
                console.log("");
            }
            if (signer) {
                console.log("#### Signer ####");
                signer.forEach(s => console.log(s));
                console.log("");
            }
            console.log("");
        };

        /* ---------------------------------------------------------------
         * Config 
        --------------------------------------------------------------- */

        log("Config", [
            `Deployer: ${deployerAddress}`,
            `Local chain ID: ${hre.network.config.chainId}`,
            `Remote chain ID: ${remoteChainId}`,
            `Remote node URL: ${remoteNodeUrl}`,
        ]);

        /* ---------------------------------------------------------------
         * Local 
        --------------------------------------------------------------- */

        const local: CanonicalPhaseDeployed = (await localConfig.getSidechain(deployer)) as any;
        const phase2 = await localConfig.getPhase2(deployer);

        log(
            "Local",
            [
                "AuraOFT address: " + local.auraOFT.address,
                "AURA balance of AuraOFT: " + formatEther(await phase2.cvx.balanceOf(local.auraOFT.address)),
                "Trusted remote address: " + (await local.auraOFT.trustedRemoteLookup(remoteLzChainId)),
            ],
            [
                "Lock balance: " + formatEther(await phase2.cvxLocker.balanceOf(deployerAddress)),
                "AURA balance: " + formatEther(await phase2.cvx.balanceOf(deployerAddress)),
            ],
        );

        /* ---------------------------------------------------------------
         * Remote 
        --------------------------------------------------------------- */

        const jsonProvider = new JsonRpcProvider(remoteNodeUrl);
        console.log("Waiting for provider...");
        await jsonProvider.ready;
        console.log("Provider ready!");
        const remoteDeployer = deployer.connect(jsonProvider);
        const remote: SidechainDeployed = (await remoteConfig.getSidechain(remoteDeployer)) as any;

        log(
            "Remote",
            [
                `Coordinator address: ${remote.coordinator.address}`,
                `Total supply: ${await remote.coordinator.totalSupply()}`,
                "Trusted remote address: " + (await remote.coordinator.trustedRemoteLookup(localLzChainId)),
            ],
            [`Balance of deployer: ${await remote.coordinator.balanceOf(deployerAddress)}`],
        );
    });

// TODO:
// task("sidechain:test:send-aura") -> sends AURA from L1 <> L2 (detect network to figure out direction)
// task("sidechhain:test:lock-aura") -> locks AURA from L2 to L1