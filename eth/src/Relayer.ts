import {
  LCDClient,
  MsgExecuteContract,
  MsgSend,
  Msg,
  Wallet,
  MnemonicKey,
  AccAddress,
  isTxError,
  Coin,
  Tx,
  TxInfo,
  Coins,
  Fee,
} from '@terra-money/terra.js';
import { MonitoringData } from 'Monitoring';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import BigNumber from 'bignumber.js';

const ax = axios.create({
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
  timeout: 15000,
});

const TERRA_MNEMONIC = process.env.TERRA_MNEMONIC as string;
const TERRA_CHAIN_ID = process.env.TERRA_CHAIN_ID as string;
const TERRA_URL = process.env.TERRA_URL as string;
const TERRA_GAS_PRICE = process.env.TERRA_GAS_PRICE as string;
const TERRA_GAS_PRICE_END_POINT = process.env
  .TERRA_GAS_PRICE_END_POINT as string;
const TERRA_GAS_PRICE_DENOM = process.env.TERRA_GAS_PRICE_DENOM as string;
const TERRA_GAS_ADJUSTMENT = process.env.TERRA_GAS_ADJUSTMENT as string;
const TERRA_DONATION = process.env.TERRA_DONATION as string;

export interface RelayDataRaw {
  tx: string;
  txHash: string;
  createdAt: number;
}

export interface RelayData {
  tx: Tx;
  txHash: string;
  createdAt: number;
}

export class Relayer {
  Wallet: Wallet;
  LCDClient: LCDClient;

  constructor() {
    // Register terra chain infos
    this.LCDClient = new LCDClient({
      URL: TERRA_URL,
      chainID: TERRA_CHAIN_ID,
      gasPrices: TERRA_GAS_PRICE,
      gasAdjustment: TERRA_GAS_ADJUSTMENT,
    });

    this.Wallet = new Wallet(
      this.LCDClient,
      new MnemonicKey({ mnemonic: TERRA_MNEMONIC })
    );
  }

  loadSequence(): Promise<number> {
    return this.Wallet.sequence();
  }

  async build(
    monitoringDatas: MonitoringData[],
    sequence: number
  ): Promise<RelayData | null> {
    let taxFees: Coins = new Coins();
    const msgs: Msg[] = [];
    for (const data of monitoringDatas) {
      const fromAddr = this.Wallet.key.accAddress;

      // If the given `to` address not proper address,
      // relayer send the funds to donation address
      const toAddr = AccAddress.validate(data.to) ? data.to : TERRA_DONATION;

      // 18 decimal to 6 decimal
      // it must bigger than 1,000,000,000,000
      if (data.amount.length < 13) {
        continue;
      }

      const amount = data.amount.slice(0, data.amount.length - 12);
      const info = data.terraAssetInfo;

      if (info.denom) {
        const denom = info.denom;
        const taxRate = await this.LCDClient.treasury.taxRate();
        const taxCap = await this.LCDClient.treasury.taxCap(denom);

        const taxAmount = BigNumber.min(
          new BigNumber(taxCap.amount.toFixed()),
          new BigNumber(taxRate.mul(amount).toFixed())
        ).toFixed();
        const taxCoin = new Coin(denom, taxAmount).toIntCeilCoin();
        const relayAmount = new BigNumber(amount)
          .minus(taxCoin.amount.toFixed())
          .toFixed(0);

        taxFees = taxFees.add(taxCoin);
        msgs.push(
          new MsgSend(fromAddr, toAddr, [new Coin(denom, relayAmount)])
        );
      } else if (info.contract_address && !info.is_eth_asset) {
        const contract_address = info.contract_address;

        msgs.push(
          new MsgExecuteContract(
            fromAddr,
            contract_address,
            {
              transfer: {
                recipient: toAddr,
                amount: amount,
              },
            },
            []
          )
        );
      } else if (info.contract_address && info.is_eth_asset) {
        const contract_address = info.contract_address;

        msgs.push(
          new MsgExecuteContract(
            fromAddr,
            contract_address,
            {
              mint: {
                recipient: toAddr,
                amount: amount,
              },
            },
            []
          )
        );
      }
    }

    if (msgs.length === 0) {
      return null;
    }

    // if something wrong, pass undefined to use default gas
    const gasPrices = await this.loadGasPrice(
      TERRA_GAS_PRICE_END_POINT,
      TERRA_GAS_PRICE_DENOM
    ).catch(() => undefined);

    const simulateTx = await this.Wallet.createTx({
      msgs,
      sequence,
      gasPrices,
    });

    const tx = await this.Wallet.createAndSignTx({
      msgs,
      sequence,
      fee: new Fee(
        simulateTx.auth_info.fee.gas_limit + 100_000 /* for tax deduction */,
        simulateTx.auth_info.fee.amount
          .mul(1 + 100000.0 / simulateTx.auth_info.fee.gas_limit)
          .add(taxFees)
          .toIntCeilCoins()
      ),
    });

    const txHash = await this.LCDClient.tx.hash(tx);

    return {
      tx,
      txHash,
      createdAt: new Date().getTime(),
    };
  }

  async relay(tx: Tx): Promise<void> {
    const result = await this.LCDClient.tx.broadcastSync(tx);

    // error code 19 means tx already in the mempool
    if (isTxError(result) && result.code !== 19) {
      throw new Error(
        `Error while executing: ${result.code} - ${result.raw_log}`
      );
    }
  }

  async getTransaction(txHash: string): Promise<TxInfo | null> {
    return await this.LCDClient.tx.txInfo(txHash).catch(() => {
      return null; // ignore not found error
    });
  }

  async loadGasPrice(url: string, denom: string): Promise<string> {
    return (await ax.get(url)).data[denom] + denom;
  }
}
