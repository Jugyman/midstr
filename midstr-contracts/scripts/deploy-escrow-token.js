import { network } from "hardhat";

async function main() {
  console.log("Starting EscrowToken deployment...");

  const { ethers } = await network.connect("sepolia");

  const tokenAddress = "0xC4D1d1AD79ad3c519D1d342D66674550d9304507";
  const stake = ethers.parseUnits("10", 18); // 10 tMIDSTR

  const EscrowToken = await ethers.getContractFactory("EscrowToken");
  const escrow = await EscrowToken.deploy(tokenAddress, stake);

  await escrow.waitForDeployment();

  console.log("EscrowToken deployed to:", await escrow.getAddress());
  console.log("Token address:", tokenAddress);
  console.log("Stake:", ethers.formatUnits(stake, 18), "tMIDSTR");
}
main().catch((error) => {
  console.error("DEPLOY FAILED:");
  console.error(error);
  process.exitCode = 1;
});