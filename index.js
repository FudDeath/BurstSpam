import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui.js/cryptography';
import chalk from 'chalk';
import util from 'util';

const log = (x) => console.log(util.inspect(x, false, null, true));

// Read environment variables
const PRIVATE_KEY = process.env.ACC1_PRIVATE_KEY || '';
const SEND_TRANSACTION_GAS_BUDGET = 10_000_000n;
const GET_GAS_COINS_GAS_BUDGET = 10_000_000n;
const GAS_PRICE = 1100n;
const TPS = 5;
const PING_INTERVAL = process.env.PING_INTERVAL * 1000;

const AMOUNTS = Array(TPS).fill(SEND_TRANSACTION_GAS_BUDGET);

const suiClient = new SuiClient({ url: process.env.URL_OVERRIDE || getFullnodeUrl('testnet') });

function getKeyPairFromExportedPrivateKey(privateKey) {
  let parsedKeyPair = decodeSuiPrivateKey(privateKey);
  return Ed25519Keypair.fromSecretKey(parsedKeyPair.secretKey);
}

const keyPair = getKeyPairFromExportedPrivateKey(PRIVATE_KEY);

const getGasCoins = async ({ suiClient, keyPair }) => {
  const txb = new TransactionBlock();

  txb.setSender(keyPair.toSuiAddress());
  txb.setGasBudget(GET_GAS_COINS_GAS_BUDGET); // Adjust gas budget as necessary
  txb.setGasPrice(GAS_PRICE);

  const results = txb.splitCoins(txb.gas, AMOUNTS);

  AMOUNTS.forEach((_, index) => {
    txb.transferObjects([results[index]], keyPair.toSuiAddress());
  });

  const bytes = await txb.build({ client: suiClient, limits: {} });

  const result = await suiClient.signAndExecuteTransactionBlock({
    signer: keyPair,
    transactionBlock: bytes,
    options: { showEffects: true },
  });

  return result.effects?.created || [];
};

const sendTransaction = async ({ suiClient, keyPair, gasCoin }) => {
  const txb = new TransactionBlock();

  // TODO Call SPAM HERE

  txb.setSender(keyPair.toSuiAddress());
  txb.setGasBudget(SEND_TRANSACTION_GAS_BUDGET); // Adjust gas budget as necessary
  txb.setGasPrice(GAS_PRICE);
  txb.setGasPayment([gasCoin]);

  const bytes = await txb.build({ client: suiClient, limits: {} });

  const startTime = performance.now();
  const result = await suiClient.signAndExecuteTransactionBlock({
    signer: keyPair,
    transactionBlock: bytes,
    options: { showEffects: true },
  });
  return { result, startTime };
};

const sleepAsync = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const main = async () => {
  let totalGasFees = 0n;
  let totalTransactions = 0;
  let startTime;

  while (true) {
    const gasCoins = await getGasCoins({ suiClient, keyPair });

    const promises = [];
    startTime = performance.now();

    for (const gas of gasCoins) {
      promises.push(
        sendTransaction({ suiClient, keyPair, gasCoin: gas.reference })
      );
    }

    const results = await Promise.allSettled(promises);

    // Extracting and logging the necessary information
    const startTimes = results
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value.startTime);

    startTimes.forEach((startTime, index) => {
      const date = new Date(startTime);
      const formattedTime = `${date.getMinutes()}:${date.getSeconds()}.${date.getMilliseconds().toString().padStart(3, '0')}`;
      const result = results[index];
      const confirmed = result.value.result.effects.status.status === 'success';
      const digest = result.value.result.digest;
      console.log(`Transaction ${index + 1} submitted at ${formattedTime} - Confirmation: ${confirmed}, Digest: ${digest}`);
      if (confirmed) {
        totalGasFees += BigInt(result.value.result.effects.gasUsed.computationCost) +
                        BigInt(result.value.result.effects.gasUsed.storageCost) -
                        BigInt(result.value.result.effects.gasUsed.storageRebate);
      }
    });

    const minStartTime = Math.min(...startTimes);
    const maxStartTime = Math.max(...startTimes);
    const timeDelta = maxStartTime - minStartTime;
    const transactionsPerSecond = startTimes.length / ((maxStartTime - minStartTime) / 1000);

    const totalGasFeesInSUI = Number(totalGasFees) / 1_000_000_000; // Convert Mist to SUI

    console.log(chalk.blue(`Time delta between first and last transaction:`) + chalk.green(` ${timeDelta} milliseconds`));
    console.log(chalk.blue(`Total gas fees:`) + chalk.green(` ${totalGasFeesInSUI} SUI, Transactions per second:`) + chalk.green(` ${transactionsPerSecond}`));

    await sleepAsync(PING_INTERVAL);
  }
};

main();
