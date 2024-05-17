import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui.js/cryptography';
import util from 'util';
import invariant from 'tiny-invariant';
import chalk from 'chalk';

const log = (x) => console.log(util.inspect(x, false, null, true));

// TODO SET THESE. Increase the budget and price if needed.
const PRIVATE_KEYS = [process.env.ACC1_PRIVATE_KEY || '', process.env.ACC2_PRIVATE_KEY || ''];
const RPC_URLS = [process.env.URL_OVERRIDE1 || getFullnodeUrl('testnet'), process.env.URL_OVERRIDE2 || getFullnodeUrl('testnet')];
const SEND_TRANSACTION_GAS_BUDGET = 15_000_000n;
const TPS = 120;
const GET_GAS_COINS_GAS_BUDGET = BigInt(TPS)*15_000_000n;
const GAS_PRICE = 1100n;
const SEQUENT_TXS = 1n;
const PING_INTERVAL = (process.env.PING_INTERVAL || 60) * 1000;
const USELESS_PKG = '0xcd7af24572133a6772fae2867d37dd65f817da917cb44a056ec38743211f66cc';

const AMOUNTS = Array(TPS).fill(SEND_TRANSACTION_GAS_BUDGET * SEQUENT_TXS);

function getKeyPairFromExportedPrivateKey(privateKey) {
  let parsedKeyPair = decodeSuiPrivateKey(privateKey);
  return Ed25519Keypair.fromSecretKey(parsedKeyPair.secretKey);
}

const checkBalance = async (suiClient, keyPair) => {
  const coins = await suiClient.getCoins({ owner: keyPair.toSuiAddress() });
  const totalBalance = coins.data.reduce((acc, coin) => acc + BigInt(coin.balance), 0n);
  return totalBalance;
};

const getGasCoins = async ({ suiClient, keyPair }) => {
  const totalBalance = await checkBalance(suiClient, keyPair);
  if (totalBalance < GET_GAS_COINS_GAS_BUDGET) {
    throw new Error('Insufficient gas balance');
  }

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

const prepareTransaction = async ({ suiClient, keyPair, gasCoin }) => {
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

  return bytes;
};

const sendPreparedTransaction = async ({ suiClient, keyPair, transactionBlock }) => {
  const startTime = performance.now();
  try {
    const result = await suiClient.signAndExecuteTransactionBlock({
      signer: keyPair,
      transactionBlock,
      options: { showEffects: true },
    });

    const endTime = performance.now();
    const latency = (endTime - startTime) / 1000;

    return { result, startTime, endTime, latency, success: true };
  } catch (error) {
    log(error);
    return { success: false };
  }
};

const run = async ({ suiClient, keyPair, gasCoins, startSignal }) => {
  let totalGasFees = 0n;
  let totalTransactions = 0;

  // Wait for the signal to start
  await startSignal;

  const preparedTransactions = await Promise.all(
    gasCoins.map(gasCoin =>
      prepareTransaction({ suiClient, keyPair, gasCoin: gasCoin.reference })
    )
  );

  while (true) {
    try {
      log('Starting transactions');

      const promises = preparedTransactions.map(tx =>
        sendPreparedTransaction({ suiClient, keyPair, transactionBlock: tx })
      );

      const results = await Promise.allSettled(promises);

      const fulfilledResults = results.filter(result => result.status === 'fulfilled' && result.value.success);
      if (fulfilledResults.length === 0) {
        console.log(chalk.blue('No transactions were successfully submitted.'));
        await new Promise(resolve => setTimeout(resolve, PING_INTERVAL));
        continue;
      }

      const startTimes = fulfilledResults.map(result => result.value.startTime);
      const endTimes = fulfilledResults.map(result => result.value.endTime);
      const latencies = fulfilledResults.map(result => result.value.latency);

      startTimes.forEach((startTime, index) => {
        const date = new Date(startTime);
        const formattedStartTime = `${date.getMinutes()}:${date.getSeconds()}.${date.getMilliseconds().toString().padStart(3, '0')}`;
        const result = fulfilledResults[index].value.result;
        const confirmed = result.effects.status.status === 'success';
        const digest = result.digest;
        const endTime = new Date(endTimes[index]);
        const formattedEndTime = `${endTime.getMinutes()}:${endTime.getSeconds()}.${endTime.getMilliseconds().toString().padStart(3, '0')}`;
        console.log(`Transaction ${index + 1} submitted at ${formattedStartTime} - Confirmed at ${formattedEndTime} - Confirmation: ${confirmed}, Digest: ${digest}`);
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
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      const totalGasFeesInSUI = Number(totalGasFees) / 1_000_000_000; // Convert Mist to SUI

      console.log(chalk.blue(`Time delta between first and last transaction:`) + chalk.green(` ${timeDelta} milliseconds`));
      console.log(chalk.blue(`Total gas fees:`) + chalk.green(` ${totalGasFeesInSUI} SUI, Transactions per second:`) + chalk.green(` ${transactionsPerSecond}`));
      console.log(chalk.blue(`Average transaction latency:`) + chalk.green(` ${avgLatency} seconds`));

      await new Promise(resolve => setTimeout(resolve, PING_INTERVAL));
    } catch (e) {
      log(e);
      await new Promise(resolve => setTimeout(resolve, PING_INTERVAL));
    }
  }
};

const main = async () => {
  if (PRIVATE_KEYS.length !== 2) {
    throw new Error('Please provide exactly 2 private keys.');
  }
  if (RPC_URLS.length !== 2) {
    throw new Error('Please provide exactly 2 RPC URLs.');
  }

  const suiClients = PRIVATE_KEYS.map((key, index) => {
    const suiClient = new SuiClient({ url: RPC_URLS[index] });
    const keyPair = getKeyPairFromExportedPrivateKey(key);
    return { suiClient, keyPair };
  });

  // Prepare start signal
  let start;
  const startSignal = new Promise(resolve => {
    start = resolve;
  });

  // Ensure both clients have sufficient gas coins before starting
  const gasCoinsArrays = await Promise.all(suiClients.map(({ suiClient, keyPair }) => getGasCoins({ suiClient, keyPair })));

  // Run both clients concurrently with pre-created gas coins
  const runPromises = suiClients.map(({ suiClient, keyPair }, index) => run({ suiClient, keyPair, gasCoins: gasCoinsArrays[index], startSignal }));

  // Trigger the start signal
  start();

  await Promise.all(runPromises);
};

main();
