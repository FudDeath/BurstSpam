import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui.js/cryptography';
import { getMetricPayload, pushMetrics, sleepAsync } from './common.js';

const COIN_TRANSFER_LATENCY_METRIC_NAME = "e2e_p2p_txn_latency_sui";
const COIN_TRANSFER_BUILD_LATENCY_METRIC_NAME = "e2e_p2p_txn_latency_build_sui";
const COIN_TRANSFER_SUCCESS_METRIC_NAME = COIN_TRANSFER_LATENCY_METRIC_NAME + "_success";
const CHAIN_NAME = process.env.CHAIN_NAME;
const PING_INTERVAL = process.env.PING_INTERVAL * 1000;
const URL_OVERRIDE = process.env.URL;
const TOTAL_TRANSACTIONS = 5; // Total number of transactions to send for the test

function getKeyPairFromExportedPrivateKey(privateKey) {
  let parsedKeyPair = decodeSuiPrivateKey(privateKey);
  return Ed25519Keypair.fromSecretKey(parsedKeyPair.secretKey);
}

const sendTransaction = async (suiClient, sender_keypair, receiver_address, gasPrice) => {
  const txb = new TransactionBlock();
  
  // Create a single coin split for the transaction
  const [coin] = txb.splitCoins(txb.gas, [txb.pure(1)]);
  
  // Transfer the coin to the receiver
  txb.transferObjects([coin], receiver_address);

  txb.setSender(sender_keypair.toSuiAddress());
  txb.setGasBudget(5_000_000);  // Adjust gas budget as necessary
  txb.setGasPrice(gasPrice);

  const buildStartTime = performance.now();
  const bytes = await txb.build({ client: suiClient, limits: {} });

  const startTime = performance.now();
  const result = await suiClient.signAndExecuteTransactionBlock({
    signer: sender_keypair,
    transactionBlock: bytes,
    options: { showEffects: true }
  });

  const endTime = performance.now();

  const buildLatency = (startTime - buildStartTime) / 1000;
  const latency = (endTime - startTime) / 1000;
  return {
    result,
    startTime
  };
}

const main = async () => {
  const SENDER_PRIVATE_KEY = process.env.ACC1_PRIVATE_KEY;
  const sender_keypair = getKeyPairFromExportedPrivateKey(SENDER_PRIVATE_KEY);
  const RECEIVER_PRIVATE_KEY = process.env.ACC2_PRIVATE_KEY || process.env.ACC1_PRIVATE_KEY;
  const receiver_keypair = getKeyPairFromExportedPrivateKey(RECEIVER_PRIVATE_KEY);
  const receiver_address = receiver_keypair.getPublicKey().toSuiAddress();

  let url = getFullnodeUrl('testnet');
  if (URL_OVERRIDE) {
      url = URL_OVERRIDE;
  }
  const suiClient = new SuiClient({ url: url });
  const gasPrice = await suiClient.getReferenceGasPrice();

  try {
    const promises = [];
    for (let i = 0; i < TOTAL_TRANSACTIONS; i++) {
      promises.push(sendTransaction(suiClient, sender_keypair, receiver_address, gasPrice));
    }

    // Wait for all transactions to be submitted
    const results = await Promise.all(promises);

    // Print results with confirmation and submission time
    results.forEach((result, index) => {
      console.log(`Transaction ${index + 1} submitted at ${new Date(result.startTime).toISOString()} confirmation result:`, result.result);
    });
  } catch (error) {
    console.log('Error:', error.message);
  }
};

main();
