import { table } from "table";
import { task } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { request, gql } from "graphql-request";
import { HardhatRuntime } from "../utils/networkAddressFactory";
import { getSigner } from "../../tasks/utils";
import { IGaugeController__factory } from "../../types/generated";
import { configs } from "./constants";
import { GaugeChoice, getGaugeChoices, getGaugeSnapshot, parseLabel } from "./utils";

task("snapshot:result", "Get results for the first proposal that uses non standard labels")
    .addParam("proposal", "The proposal ID of the snapshot")
    .addOptionalParam("debug", "Debug mode", "false")
    .setAction(async function (taskArgs: TaskArguments, hre: HardhatRuntime) {
        const signer = await getSigner(hre);

        const query = gql`
            query Proposal($proposal: String) {
                proposal(id: $proposal) {
                    id
                    scores_total
                    scores
                    choices
                    scores_state
                }
            }
        `;

        console.log("Fetching vote results...");
        const config = configs.main;
        const proposalId = taskArgs.proposal;
        const debug = taskArgs.debug === "true";
        const data = await request(`${config.hub}/graphql`, query, { proposal: proposalId });
        const proposal = data.proposal;
        if (proposal.scores_state !== "final" && !debug) {
            console.log("Scores not final");
            console.log("Exiting...");
            return;
        }

        for (let i = 0; i < proposal.choices.length; i++) {
            if (
                proposal.choices[i] === "a-ComposableStable DUSD/bb-a-USD" ||
                proposal.choices[i] === "p-ComposableStable bb-am-usd/DUSD"
            ) {
                const idx = proposal.choices.findIndex((x: string) => x === "ComposableStable DUSD/bb-a-USD");
                proposal.scores[idx] += proposal.scores[i];
                proposal.scores[i] = 0;
                console.log(`[*] Forward ${proposal.choices[i]} votes to ${proposal.choices[idx]}`);
            }
        }

        let choices = [] as string[];
        let scores = [] as number[];
        for (let i = 0; i < proposal.choices.length; i++) {
            const score = proposal.scores[i];
            const percentage = score / proposal.scores_total;
            if (percentage >= 0.002) {
                choices.push(proposal.choices[i]);
                scores.push(proposal.scores[i]);
            }
        }
        proposal.choices = choices;
        proposal.scores = scores;

        const gaugeList = getGaugeChoices();

        for (let i = 0; i < proposal.choices.length; i++) {
            const choice = proposal.choices[i];
            const resp = gaugeList.find((gauge: GaugeChoice) => gauge.label === choice);

            if (resp.label === "ComposableStable R/bb-s-DAI") {
                console.log("[*] Move R/bb-s-DAI votes to R/DAI");
                const rDaiIndex = proposal.choices.findIndex((x: string) => x === "ComposableStable R/DAI");
                proposal.scores[rDaiIndex] += proposal.scores[i];
                proposal.scores[i] = 0;
            } else if (resp.label === "ComposableStable ETHx/bb-a-WETH") {
                console.log("[*] ETHx keep core pool incentives ($2700/$12000) and refund the rest");
                proposal.scores[i] = (proposal.scores[i] * 2700) / 12000;
            } else if (resp.label === "a-ComposableStable bb-USD+/DOLA") {
                console.log("[*] Move half bb-USD+/DOLA votes to INV/DOLA and refund the other half");
                const invDolaIndex = proposal.choices.findIndex((x: string) => x === "50/50 INV/DOLA");
                proposal.scores[invDolaIndex] += proposal.scores[i] / 2;
                proposal.scores[i] = 0;
            } else if (resp.label === "ComposableStable bb-g-USDC/bb-g-DAI") {
                console.log("[*] Refund bb-g-USDC/bb-g-DAI");
                proposal.scores[i] = 0;
            } else if (resp.label === "ComposableStable qETH/bb-a-WETH") {
                console.log("[*] Refund qETH/bb-a-WETH");
                proposal.scores[i] = 0;
            } else if (resp.label === "a-ComposableStable DOLA/bb-a-USD") {
                console.log("[*] Send votes from DOLA/bb-a-USD to INV/DOLA");
                const invDolaIndex = proposal.choices.findIndex((x: string) => x === "50/50 INV/DOLA");
                proposal.scores[invDolaIndex] += proposal.scores[i];
                proposal.scores[i] = 0;
            } else if (resp.label === "a-ComposableStable bb-DAI+/bb-USD+") {
                console.log("[*] No incentives for bb-DAI+ so just zero out");
                proposal.scores[i] = 0;
            } else if (resp.label === "ComposableStable GHO/bb-a-USD") {
                console.log("[*] Keep 50% of GHO votes on GHO/3POOL and send 50% to GHO/LUSD");
                const ghoLusdIndex = proposal.choices.findIndex((x: string) => x === "ComposableStable GHO/LUSD");
                const newScore = proposal.scores[i] / 2;
                proposal.scores[ghoLusdIndex] += newScore;
                proposal.scores[i] = newScore;
            }
        }

        // ----------------------------------------------------------
        // Get Gauge Weight Votes
        // ----------------------------------------------------------
        console.log("Parsing vote results...");

        const results: { choice: string; score: number; percentage: number; address: string }[] = [];

        for (let i = 0; i < proposal.choices.length; i++) {
            const score = proposal.scores[i];
            const choice = proposal.choices[i];
            const percentage = score / proposal.scores_total;
            const resp = gaugeList.find((gauge: GaugeChoice) => gauge.label === choice);

            results.push({ choice, score, percentage, address: resp?.address });
        }

        const successfulGauges = results.sort((a, b) => b.percentage - a.percentage);

        // ----------------------------------------------------------
        // Get Existing Votes
        // Look up the existing vote weight that was previous given to all the gauges
        // ----------------------------------------------------------

        console.log("Getting existing vote weights...");
        const gaugeSnapshot = getGaugeSnapshot();
        const voterProxyAddress = "0xaF52695E1bB01A16D33D7194C28C42b10e0Dbec2";
        const gaugeControllerAddress = "0xc128468b7ce63ea702c1f104d55a2566b13d3abd";
        const gaugeController = IGaugeController__factory.connect(gaugeControllerAddress, signer);
        const gaugesWithExistingWeights = [];
        for (let i = 0; i < gaugeSnapshot.length; i++) {
            const gauge = gaugeSnapshot[i];
            const [, power] = await gaugeController.vote_user_slopes(voterProxyAddress, gauge.address);
            gaugesWithExistingWeights.push({ address: gauge.address, label: parseLabel(gauge), existingWeight: power });
        }
        for (let i = 0; i < successfulGauges.length; i++) {
            const gauge = successfulGauges[i];
            if (gaugesWithExistingWeights.find(r => r.address.toLowerCase() === gauge.address.toLowerCase())) continue;
            const [, power] = await gaugeController.vote_user_slopes(voterProxyAddress, gauge.address);
            gaugesWithExistingWeights.push({ address: gauge.address, label: gauge.choice, existingWeight: power });
        }

        // ----------------------------------------------------------
        // Get New Votes
        // ----------------------------------------------------------

        console.log("Parsing new votes...");
        const totalVotes = 10000;
        const sumOfPercentages = successfulGauges.reduce((acc, x) => acc + x.percentage, 0);
        const weights = successfulGauges.map(gauge => Math.floor((totalVotes * gauge.percentage) / sumOfPercentages));
        const totalWeightBefore = weights.reduce((acc, x) => acc + x, 0);

        const voteDelta = totalVotes - totalWeightBefore;
        weights[0] += voteDelta;

        const totalWeightAfter = weights.reduce((acc, x) => acc + x, 0);

        if (totalWeightAfter !== totalVotes) {
            console.log("Total weight is not equal to total votes.");
            console.log("Exiting...");
            return;
        }

        // ----------------------------------------------------------
        // Order Votes
        // gauges that don't have any votes in this epoch need to be sent with weight 0
        // gauges that have decreased in vote weight have to be sent first
        // ----------------------------------------------------------

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        interface Vote {
            gauge: GaugeChoice;
            voteDelta: number;
            voteWeight: number;
            percentage: number;
        }
        let votes: Vote[] = [];
        for (const gauge of gaugesWithExistingWeights) {
            const idx = successfulGauges.findIndex(g => gauge.address === g.address);
            if (~idx) {
                // Gauge that we want to cast a vote for this time
                const voteWeight = weights[idx];
                const voteGauge = successfulGauges[idx];
                const voteDelta = voteWeight - gauge.existingWeight.toNumber();
                votes.push({ gauge, voteDelta, voteWeight, percentage: voteGauge.percentage });
            } else if (gauge.existingWeight.gt(0)) {
                // Gauge not found in vote list but it has a weight already
                // so we need to send a vote to reset it to 0.
                votes.push({ gauge, voteDelta: gauge.existingWeight.toNumber(), voteWeight: 0, percentage: 0 });
            }
        }

        // sort votes by lowest delta first
        votes = votes.sort((a, b) => a.voteDelta - b.voteDelta);
        votes = votes.sort(a => (a.voteWeight === 0 ? -1 : 1));

        // ----------------------------------------------------------
        // Processing
        // ----------------------------------------------------------

        console.log("Successfull gauge votes");
        const tableData = [
            ["Gauge", "voteDelta", "percentage", "address", "weight"],
            ...votes.map(({ gauge, voteDelta, voteWeight, percentage }) => [
                gauge.label,
                voteDelta,
                (percentage * 100).toFixed(2) + "%",
                gauge.address,
                voteWeight,
            ]),
        ];
        console.log(table(tableData));

        console.log("\n\nGauge Labels");
        console.log(JSON.stringify(tableData.slice(1).map(x => x[0])));

        console.log("\n\nGauge Addresses");
        console.log(JSON.stringify(votes.map(v => v.gauge.address)));

        console.log("\n\nVote weights");
        console.log(JSON.stringify(votes.map(v => v.voteWeight)));
    });
