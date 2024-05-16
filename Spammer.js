import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui.js/cryptography';
import chalk from 'chalk';
import util from 'util';

const log = (x) => console.log(util.inspect(x, false, null, true));

// TODO SET THESE. Increase the budget and price if needed.
const PRIVATE_KEY = process.env.ACC1_PRIVATE_KEY || '';
const SEND_TRANSACTION_GAS_BUDGET = 15_000_000n;
const GET_GAS_COINS_GAS_BUDGET = 15_000_000n;
const GAS_PRICE = 1100n;
const TPS = 2;
const SEQUENT_TXS = 10n;
const PING_INTERVAL = process.env.PING_INTERVAL * 1000;

const AMOUNTS = Array(TPS).fill(SEND_TRANSACTION_GAS_BUDGET * SEQUENT_TXS);

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

  const results = txb.splitCoins(
    txb.gas,
    AMOUNTS.map((x) => txb.pure.u64(x))
  );

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

  txb.setSender(keyPair.toSuiAddress());
  txb.setGasBudget(SEND_TRANSACTION_GAS_BUDGET); // Adjust gas budget as necessary
  txb.setGasPrice(GAS_PRICE);
  txb.setGasPayment([gasCoin]);

  const object = txb.moveCall({
    target: `${USELESS_PKG}::useless::new`,
  });

  txb.moveCall({
    target: `${USELESS_PKG}::useless::destroy`,
    arguments: [object],
  });

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

const loop = async (data) => {
  const promises = [];
  for (const result of data) {
    promises.push(
      sendTransaction({
        suiClient,
        keyPair,
        gasCoin: result[0].reference,
      })
    );
  }

  const remainingGasCoin = await Promise.all(promises);

  log('Batch sent');

  if (remainingGasCoin.length) await loop(remainingGasCoin);
};

const main = async () => {
  let totalGasFees = 0n;
  let totalTransactions = 0;

  while (true) {
    try {
      const gasCoins = await getGasCoins({ suiClient, keyPair });

      log('Gas Coins Created');

      const promises = [];
      const startTime = performance.now();

      for (const gas of gasCoins) {
        promises.push(
          sendTransaction({ suiClient, keyPair, gasCoin: gas.reference })
        );
      }

      const results = await Promise.allSettled(promises);

      const fulfilledResults = results.filter(result => result.status === 'fulfilled' && !result.value.error);
      if (fulfilledResults.length === 0) {
        console.log(chalk.blue('No transactions were successfully submitted.'));
        await sleepAsync(PING_INTERVAL);
        continue;
      }

      const startTimes = fulfilledResults.map(result => result.value.startTime);

      startTimes.forEach((startTime, index) => {
        const date = new Date(startTime);
        const formattedTime = `${date.getMinutes()}:${date.getSeconds()}.${date.getMilliseconds().toString().padStart(3, '0')}`;
        const result = fulfilledResults[index].value.result;
        const confirmed = result.effects.status.status === 'success';
        const digest = result.digest;
        console.log(`Transaction ${index + 1} submitted at ${formattedTime} - Confirmation: ${confirmed}, Digest: ${digest}`);
        if (confirmed) {
          totalGasFees += BigInt(result.effects.gasUsed.computationCost) +
                          BigInt(result.effects.gasUsed.storageCost) -
                          BigInt(result.effects.gasUsed.storageRebate);
        }
      });

      const minStartTime = Math.min(...startTimes);
      const maxStartTime = Math.max(...startTimes);
      const timeDelta = maxStartTime - minStartTime;
      const transactionsPerSecond = TPS;

      const totalGasFeesInSUI = Number(totalGasFees) / 1_000_000_000; // Convert Mist to SUI

      console.log(chalk.blue(`Time delta between first and last transaction:`) + chalk.green(` ${timeDelta} milliseconds`));
      console.log(chalk.blue(`Total gas fees:`) + chalk.green(` ${totalGasFeesInSUI} SUI, Transactions per second:`) + chalk.green(` ${transactionsPerSecond}`));

      await sleepAsync(PING_INTERVAL);
    } catch (e) {
      log(e);
      await sleepAsync(PING_INTERVAL);
    }
  }
};

main();
