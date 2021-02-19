/* Imports: External */
import { BigNumber, ethers } from 'ethers'
import { getContractFactory } from '@eth-optimism/contracts'
import {
  ctcCoder,
  fromHexString,
  toHexString,
  TxType,
} from '@eth-optimism/core-utils'

/* Imports: Internal */
import {
  DecodedSequencerBatchTransaction,
  EventArgsSequencerBatchAppended,
  TransactionBatchEntry,
  TransactionEntry,
  EventHandlerSet,
} from '../../../types'
import { recoverAddress } from 'ethers/lib/utils'

export const handleEventsSequencerBatchAppended: EventHandlerSet<
  EventArgsSequencerBatchAppended,
  {
    timestamp: number
    blockNumber: number
    submitter: string
    l1TransactionData: string
    l1TransactionHash: string
    gasLimit: number

    // Stuff from TransactionBatchAppended.
    prevTotalElements: BigNumber
    batchIndex: BigNumber
    batchSize: BigNumber
    batchRoot: string
    batchExtraData: string
  },
  {
    transactionBatchEntry: TransactionBatchEntry
    transactionEntries: TransactionEntry[]
  }
> = {
  getExtraData: async (event, l1RpcProvider) => {
    const l1Transaction = await event.getTransaction()
    const eventBlock = await event.getBlock()

    // TODO: We need to update our events so that we actually have enough information to parse this
    // batch without having to pull out this extra event. For the meantime, we need to find this
    // "TransactonBatchAppended" event to get the rest of the data.
    const OVM_CanonicalTransactionChain = getContractFactory(
      'OVM_CanonicalTransactionChain'
    )
      .attach(event.address)
      .connect(l1RpcProvider)

    const batchSubmissionEvent = (
      await OVM_CanonicalTransactionChain.queryFilter(
        OVM_CanonicalTransactionChain.filters.TransactionBatchAppended(),
        eventBlock.number,
        eventBlock.number
      )
    ).find((foundEvent: ethers.Event) => {
      // We might have more than one event in this block, so we specifically want to find a
      // "TransactonBatchAppended" event emitted immediately before the event in question.
      return (
        foundEvent.transactionHash === event.transactionHash &&
        foundEvent.logIndex === event.logIndex - 1
      )
    })

    if (!batchSubmissionEvent) {
      throw new Error(
        `Well, this really shouldn't happen. A SequencerBatchAppended event doesn't have a corresponding TransactionBatchAppended event.`
      )
    }

    return {
      timestamp: eventBlock.timestamp,
      blockNumber: eventBlock.number,
      submitter: l1Transaction.from,
      l1TransactionHash: l1Transaction.hash,
      l1TransactionData: l1Transaction.data,
      gasLimit: 8_000_000, // Fixed to this currently.

      prevTotalElements: batchSubmissionEvent.args._prevTotalElements,
      batchIndex: batchSubmissionEvent.args._batchIndex,
      batchSize: batchSubmissionEvent.args._batchSize,
      batchRoot: batchSubmissionEvent.args._batchRoot,
      batchExtraData: batchSubmissionEvent.args._extraData,
    }
  },
  parseEvent: async (event, extraData) => {
    const transactionEntries: TransactionEntry[] = []

    // It's easier to deal with this data if it's a Buffer.
    const calldata = fromHexString(extraData.l1TransactionData)

    const numContexts = BigNumber.from(calldata.slice(12, 15)).toNumber()
    let transactionIndex = 0
    let enqueuedCount = 0
    let nextTxPointer = 15 + 16 * numContexts
    for (let i = 0; i < numContexts; i++) {
      const contextPointer = 15 + 16 * i
      const context = parseSequencerBatchContext(calldata, contextPointer)

      for (let j = 0; j < context.numSequencedTransactions; j++) {
        const sequencerTransaction = parseSequencerBatchTransaction(
          calldata,
          nextTxPointer
        )

        const { decoded, type } = maybeDecodeSequencerBatchTransaction(
          sequencerTransaction
        )

        transactionEntries.push({
          index: extraData.prevTotalElements
            .add(BigNumber.from(transactionIndex))
            .toNumber(),
          batchIndex: extraData.batchIndex.toNumber(),
          blockNumber: BigNumber.from(context.blockNumber).toNumber(),
          timestamp: BigNumber.from(context.timestamp).toNumber(),
          gasLimit: BigNumber.from(extraData.gasLimit).toNumber(),
          target: '0x4200000000000000000000000000000000000005', // TODO: Maybe this needs to be configurable?
          origin: null,
          data: toHexString(sequencerTransaction),
          queueOrigin: 'sequencer',
          type,
          queueIndex: null,
          decoded,
        })

        nextTxPointer += 3 + sequencerTransaction.length
        transactionIndex++
      }

      for (let j = 0; j < context.numSubsequentQueueTransactions; j++) {
        const queueIndex = event.args._startingQueueIndex.add(
          BigNumber.from(enqueuedCount)
        )

        // Okay, so. Since events are processed in parallel, we don't know if the Enqueue
        // event associated with this queue element has already been processed. So we'll ask
        // the api to fetch that data for itself later on and we use fake values for some
        // fields. The real TODO here is to make sure we fix this data structure to avoid ugly
        // "dummy" fields.
        transactionEntries.push({
          index: extraData.prevTotalElements
            .add(BigNumber.from(transactionIndex))
            .toNumber(),
          batchIndex: extraData.batchIndex.toNumber(),
          blockNumber: BigNumber.from(0).toNumber(),
          timestamp: BigNumber.from(0).toNumber(),
          gasLimit: BigNumber.from(0).toNumber(),
          target: '0x0000000000000000000000000000000000000000',
          origin: '0x0000000000000000000000000000000000000000',
          data: '0x',
          queueOrigin: 'l1',
          type: 'EIP155',
          queueIndex: queueIndex.toNumber(),
          decoded: null,
        })

        enqueuedCount++
        transactionIndex++
      }
    }

    const transactionBatchEntry: TransactionBatchEntry = {
      index: extraData.batchIndex.toNumber(),
      root: extraData.batchRoot,
      size: extraData.batchSize.toNumber(),
      prevTotalElements: extraData.prevTotalElements.toNumber(),
      extraData: extraData.batchExtraData,
      blockNumber: BigNumber.from(extraData.blockNumber).toNumber(),
      timestamp: BigNumber.from(extraData.timestamp).toNumber(),
      submitter: extraData.submitter,
      l1TransactionHash: extraData.l1TransactionHash,
    }

    return {
      transactionBatchEntry,
      transactionEntries,
    }
  },
  storeEvent: async (entry, db) => {
    await db.putTransactionBatchEntries([entry.transactionBatchEntry])
    await db.putTransactionEntries(entry.transactionEntries)

    // Add an additional field to the enqueued transactions in the database
    // if they have already been confirmed
    for (const transactionEntry of entry.transactionEntries) {
      if (transactionEntry.queueOrigin === 'l1') {
        await db.putTransactionIndexByQueueIndex(
          transactionEntry.queueIndex,
          transactionEntry.index
        )
      }
    }
  },
}

interface SequencerBatchContext {
  numSequencedTransactions: number
  numSubsequentQueueTransactions: number
  timestamp: number
  blockNumber: number
}

const parseSequencerBatchContext = (
  calldata: Buffer,
  offset: number
): SequencerBatchContext => {
  return {
    numSequencedTransactions: BigNumber.from(
      calldata.slice(offset, offset + 3)
    ).toNumber(),
    numSubsequentQueueTransactions: BigNumber.from(
      calldata.slice(offset + 3, offset + 6)
    ).toNumber(),
    timestamp: BigNumber.from(
      calldata.slice(offset + 6, offset + 11)
    ).toNumber(),
    blockNumber: BigNumber.from(
      calldata.slice(offset + 11, offset + 16)
    ).toNumber(),
  }
}

const parseSequencerBatchTransaction = (
  calldata: Buffer,
  offset: number
): Buffer => {
  const transactionLength = BigNumber.from(
    calldata.slice(offset, offset + 3)
  ).toNumber()

  return calldata.slice(offset + 3, offset + 3 + transactionLength)
}

const maybeDecodeSequencerBatchTransaction = (
  transaction: Buffer
): {
  decoded: DecodedSequencerBatchTransaction | null
  type: 'EIP155' | 'ETH_SIGN' | null
} => {
  let decoded = null
  let type = null

  try {
    const txType = transaction.slice(0, 1).readUInt8()
    if (txType === TxType.EIP155) {
      type = 'EIP155'
      decoded = ctcCoder.eip155TxData.decode(transaction.toString('hex'))
    } else if (txType === TxType.EthSign) {
      type = 'ETH_SIGN'
      decoded = ctcCoder.ethSignTxData.decode(transaction.toString('hex'))
    } else {
      throw new Error(`Unknown sequencer transaction type.`)
    }
    // Validate the transaction
    if (!validateBatchTransaction(type, decoded)) {
      decoded = null
    }
  } catch (err) {
    // Do nothing
  }

  return {
    decoded,
    type,
  }
}

export function validateBatchTransaction(
  type: string | null,
  decoded: DecodedSequencerBatchTransaction | null
): boolean {
  // Unknown types are considered invalid
  if (type === null) {
    return false
  }

  // The only v we currently deocde to, others considered invalid
  if (decoded.sig.v !== 1 && decoded.sig.v !== 0) {
    return false
  }

  if (type === 'EIP155') {
    // Note: reformattedTx is a shallow copy of decoded, 
    // so both reformatted.sig and decoded.sig point to same object
    const reformattedTx = { ...decoded, to: decoded.target } 
    delete reformattedTx.sig
    delete reformattedTx.target
    
    const reformattedSig = { ...decoded.sig }
    reformattedSig.v += 35 + 2 * 10 // hardcode chainid 10 for now

    const recoveringSig = { ...decoded.sig }
    recoveringSig.v += 27 // copying https://github.com/ethereum-optimism/contracts-v2/blob/7b79dd66965f727faf2c68672240918e20908aa1/contracts/optimistic-ethereum/libraries/utils/Lib_ECDSAUtils.sol#L22-L43

    const rawTx = ethers.utils.serializeTransaction(
      reformattedTx,
      reformattedSig
      // recoveringSig
    )
    const msgHash = ethers.utils.keccak256(rawTx)
    
    const recoveredAddress = ethers.utils.recoverAddress(
      msgHash,
      // rawTx,
      reformattedSig
      // recoveringSig
    )

    const parsedTx = ethers.utils.parseTransaction(rawTx)

    console.log(`recoveredAddress: ${recoveredAddress}`)
    console.log(`parsed: `)
    console.log(parsedTx)

    return recoveredAddress === parsedTx.from
  }

  // Allow soft forks
  return false
}
