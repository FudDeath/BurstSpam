import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui.js/cryptography';
import util from 'util';
import invariant from 'tiny-invariant';
import chalk from 'chalk';

const log = (x) => console.log(util.inspect(x, false, null, true));

const PRIVATE_KEYS = [process.env.ACC1_PRIVATE_KEY || '', process.env.ACC2_PRIVATE_KEY || ''];
const RPC_URLS = [process.env.URL_OVERRIDE1 || getFullnodeUrl('testnet'), process.env.URL_OVERRIDE2 || getFullnodeUrl('testnet')];
const SEND_TRANSACTION_GAS_BUDGET = 15_000_000n;
const TPS = 125;
const GET_GAS_COINS_GAS_BUDGET = BigInt(TPS) * 15_000_000n;
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
  txb.setGasBudget(GET_GAS_COINS_GAS_BUDGET);
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
  txb.setGasBudget(SEND_TRANSACTION_GAS_BUDGET);
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

const formatTimestamp = (timestamp) => {
  const date = new Date(timestamp);
  return `${date.getMinutes()}:${date.getSeconds()}.${date.getMilliseconds().toString().padStart(3, '0')}`;
};

const run = async ({ suiClients, gasCoinsArrays, startSignal }) => {
  await startSignal;

  const preparedTransactions = await Promise.all(
    suiClients.flatMap(({ suiClient, keyPair }, index) =>
      gasCoinsArrays[index].map(gasCoin =>
        prepareTransaction({ suiClient, keyPair, gasCoin: gasCoin.reference })
      )
    )
  );

  console.log(chalk.red('Starting transactions'));

  while (true) {
    const promises = preparedTransactions.map((tx, index) => {
      const { suiClient, keyPair } = suiClients[Math.floor(index / gasCoinsArrays[0].length)];
      return sendPreparedTransaction({ suiClient, keyPair, transactionBlock: tx });
    });

    const results = await Promise.allSettled(promises);

    const fulfilledResults = results.filter(result => result.status === 'fulfilled' && result.value.success);
    if (fulfilledResults.length === 0) {
      console.log(chalk.blue('No transactions were successfully submitted.'));
      await new Promise(resolve => setTimeout(resolve, PING_INTERVAL));
      continue;
    }

    fulfilledResults.forEach((result, index) => {
      const { startTime, endTime, result: txResult } = result.value;
      const formattedStartTime = formatTimestamp(startTime);
      const formattedEndTime = formatTimestamp(endTime);
      const confirmed = txResult.effects.status.status === 'success';
      const digest = txResult.digest;
      console.log(`Transaction ${index + 1} submitted at ${formattedStartTime} - Confirmed at ${formattedEndTime} - Confirmation: ${confirmed}, Digest: ${digest}`);
    });

    const startTimes = fulfilledResults.map(result => result.value.startTime);
    const endTimes = fulfilledResults.map(result => result.value.endTime);
    const latencies = fulfilledResults.map(result => result.value.latency);

    const minStartTime = Math.min(...startTimes);
    const maxStartTime = Math.max(...startTimes);
    const timeDelta = maxStartTime - minStartTime;
    const transactionsPerSecond = fulfilledResults.length / (timeDelta / 1000);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    console.log(chalk.blue(`Time delta between first and last transaction:`) + chalk.green(` ${timeDelta} milliseconds`));
    console.log(chalk.blue(`Transactions per second:`) + chalk.green(` ${transactionsPerSecond}`));
    console.log(chalk.blue(`Average transaction latency:`) + chalk.green(` ${avgLatency} seconds`));

    await new Promise(resolve => setTimeout(resolve, PING_INTERVAL));
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

  let start;
  const startSignal = new Promise(resolve => {
    start = resolve;
  });

  const gasCoinsArrays = await Promise.all(suiClients.map(({ suiClient, keyPair }) => getGasCoins({ suiClient, keyPair })));

  // Ensure both clients are ready and synchronized
  const runPromise = run({ suiClients, gasCoinsArrays, startSignal });

  // Trigger the start signal simultaneously
  setTimeout(start, 0);

  await runPromise;
};

main();
