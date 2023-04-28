import { Signer } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types/runtime";
import {
    MultisigConfig,
    Phase2Deployed,
    Phase6Deployed,
    deployPhase1,
    deployPhase2,
    deployPhase3,
    deployPhase4,
    deployPhase6,
} from "../../scripts/deploySystem";
import { DeployMocksResult, deployMocks, getMockDistro, getMockMultisigs } from "../../scripts/deployMocks";
import { impersonateAccount } from "../../test-utils/fork";
import {
    deployCanonicalPhase,
    deploySidechainSystem,
    setTrustedRemoteCanonical,
    CanonicalPhaseDeployed,
    SidechainDeployed,
    setTrustedRemoteSidechain,
} from "../../scripts/deploySidechain";
import { Account, Create2Factory__factory, LZEndpointMock__factory, SidechainMultisigConfig } from "../../types";
import {
    DeployL2MocksResult,
    deploySidechainMocks,
    getMockMultisigs as getL2MockMultisigs,
} from "../../scripts/deploySidechainMocks";
import { deploySimpleBridgeDelegates, SimplyBridgeDelegateDeployed } from "../../scripts/deployBridgeDelegates";
import { deployVault } from "../../scripts/deployVault";

export interface L1TestSetup {
    mocks: DeployMocksResult;
    multisigs: MultisigConfig;
    phase2: Phase2Deployed;
    phase6: Phase6Deployed;
    canonical: CanonicalPhaseDeployed;
}
export interface L2TestSetup {
    mocks: DeployL2MocksResult;
    multisigs: SidechainMultisigConfig;
    sidechain: SidechainDeployed;
}
export interface SideChainTestSetup {
    deployer: Account;
    l1: L1TestSetup;
    l2: L2TestSetup;
    bridgeDelegates: SimplyBridgeDelegateDeployed;
}

/**
 * Full deployment of the system in order to test sidechain stuff.
 * - L1: phase 1 to 6, canonical phase, mocks, multisigs
 * - L2: phase 1 to 2, mocks, multisigs
 *
 * - Configures layer zero to enable communication between L1 <=> L2
 *
 * @param {HardhatRuntimeEnvironment} hre - The Hardhat runtime environment
 * @param {Signer[]} accounts - Array of accounts to use.
 * @param {number} canonicalChainId - The ID of the canonical chain, or L1
 * @param {number} sidechainLzChainId - The ID of the canonical chain, or L2
 * @returns {SideChainTestSetup}
 */
export const sidechainTestSetup = async (
    hre: HardhatRuntimeEnvironment,
    accounts: Signer[],
    canonicalChainId = 111,
    sidechainLzChainId = 222,
    debug = false,
    waitForBlocks = 0,
): Promise<SideChainTestSetup> => {
    const deployer = await impersonateAccount(await accounts[0].getAddress());
    const l1Mocks = await deployMocks(hre, deployer.signer);
    const l2mocks = await deploySidechainMocks(hre, deployer.signer, canonicalChainId, debug, waitForBlocks);
    const l1Multisigs = await getMockMultisigs(accounts[1], accounts[2], accounts[3]);
    const l2Multisigs = await getL2MockMultisigs(accounts[3]);
    const dao = await impersonateAccount(l2Multisigs.daoMultisig);

    const distro = getMockDistro();
    const phase1 = await deployPhase1(hre, deployer.signer, l1Mocks.addresses);
    const phase2 = await deployPhase2(
        hre,
        deployer.signer,
        phase1,
        distro,
        l1Multisigs,
        l1Mocks.namingConfig,
        l1Mocks.addresses,
    );
    const phase3 = await deployPhase3(hre, deployer.signer, phase2, l1Multisigs, l1Mocks.addresses);
    await phase3.poolManager.connect(dao.signer).setProtectPool(false);
    await deployPhase4(hre, deployer.signer, phase3, l1Mocks.addresses);
    const phase6 = await deployPhase6(
        hre,
        deployer.signer,
        phase2,
        l1Multisigs,
        l1Mocks.namingConfig,
        l1Mocks.addresses,
    );
    const vaultDeployment = await deployVault(
        {
            addresses: l1Mocks.addresses,
            multisigs: l1Multisigs,
            getPhase2: async (__: Signer) => phase2,
            getPhase6: async (__: Signer) => phase6,
        },
        hre,
        deployer.signer,
    );

    // deploy canonicalPhase
    const canonical = await deployCanonicalPhase(
        hre,
        deployer.signer,
        l1Multisigs,
        l1Mocks.addresses,
        phase2,
        phase6,
        vaultDeployment,
    );
    // deploy sidechain
    const create2Factory = await new Create2Factory__factory(deployer.signer).deploy();
    await create2Factory.updateDeployer(deployer.address, true);

    const l2LzEndpoint = await new LZEndpointMock__factory(deployer.signer).deploy(sidechainLzChainId);
    l2mocks.addresses.lzEndpoint = l2LzEndpoint.address;

    const sidechain = await deploySidechainSystem(hre, deployer.signer, l2mocks.namingConfig, l2Multisigs, {
        ...l2mocks.addresses,
        create2Factory: create2Factory.address,
    });

    await sidechain.poolManager.connect(dao.signer).setProtectPool(false);
    // Mock L1 Endpoints  configuration
    await l1Mocks.lzEndpoint.setDestLzEndpoint(sidechain.l2Coordinator.address, l2LzEndpoint.address);
    await l1Mocks.lzEndpoint.setDestLzEndpoint(sidechain.auraOFT.address, l2LzEndpoint.address);
    await l1Mocks.lzEndpoint.setDestLzEndpoint(sidechain.auraBalOFT.address, l2LzEndpoint.address);

    // Mock L12Endpoints  configuration
    await l2LzEndpoint.setDestLzEndpoint(canonical.l1Coordinator.address, l1Mocks.lzEndpoint.address);
    await l2LzEndpoint.setDestLzEndpoint(canonical.auraProxyOFT.address, l1Mocks.lzEndpoint.address);
    await l2LzEndpoint.setDestLzEndpoint(canonical.auraBalProxyOFT.address, l1Mocks.lzEndpoint.address);

    // Add Mock Gauge
    await sidechain.poolManager["addPool(address)"](l2mocks.gauge.address);

    // Emulate DAO Settings - L1 Stuff
    await phase6.booster.connect(dao.signer).setBridgeDelegate(canonical.l1Coordinator.address);
    canonical.l1Coordinator = canonical.l1Coordinator.connect(dao.signer);
    canonical.auraProxyOFT = canonical.auraProxyOFT.connect(dao.signer);
    canonical.auraBalProxyOFT = canonical.auraBalProxyOFT.connect(dao.signer);
    await setTrustedRemoteCanonical(canonical, sidechain, sidechainLzChainId);

    // Emulate DAO Settings - L2 Stuff
    sidechain.l2Coordinator = sidechain.l2Coordinator.connect(dao.signer);
    sidechain.auraOFT = sidechain.auraOFT.connect(dao.signer);
    sidechain.auraBalOFT = sidechain.auraBalOFT.connect(dao.signer);
    await setTrustedRemoteSidechain(canonical, sidechain, l2mocks.addresses.canonicalChainId);

    const sbd = await deploySimpleBridgeDelegates(
        hre,
        l1Mocks.addresses,
        canonical,
        sidechainLzChainId,
        deployer.signer,
    );
    await canonical.l1Coordinator
        .connect(dao.signer)
        .setBridgeDelegate(sidechainLzChainId, sbd.bridgeDelegateReceiver.address);
    await canonical.l1Coordinator
        .connect(dao.signer)
        .setL2Coordinator(sidechainLzChainId, sidechain.l2Coordinator.address);

    await sidechain.l2Coordinator.connect(dao.signer).setBridgeDelegate(sbd.bridgeDelegateSender.address);

    // Revert connected contracts with deployer signer
    canonical.l1Coordinator = canonical.l1Coordinator.connect(deployer.signer);
    sidechain.l2Coordinator = sidechain.l2Coordinator.connect(deployer.signer);
    sidechain.auraOFT = sidechain.auraOFT.connect(deployer.signer);
    sidechain.auraBalOFT = sidechain.auraBalOFT.connect(deployer.signer);
    return {
        deployer,
        l1: { mocks: l1Mocks, multisigs: l1Multisigs, phase2, phase6, canonical },
        l2: { mocks: l2mocks, multisigs: l2Multisigs, sidechain },
        bridgeDelegates: { ...sbd },
    };
};