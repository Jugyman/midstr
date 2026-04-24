import { network } from "hardhat";

async function main() {
  console.log("Starting TestMIDSTR deployment...");

  const { ethers } = await network.connect("sepolia");

  const TestMIDSTR = await ethers.getContractFactory("TestMIDSTR");
  console.log("Factory loaded");

  const token = await TestMIDSTR.deploy();
  console.log("Deploy transaction sent");

  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log("TestMIDSTR deployed to:", address);
}

main().catch((error) => {
  console.error("DEPLOY FAILED:");
  console.error(error);
  process.exitCode = 1;
});