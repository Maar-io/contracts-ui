// Copyright 2022 @paritytech/contracts-ui authors & contributors
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState, useRef, useMemo } from 'react';
import { ContractSubmittableResult } from '@polkadot/api-contract/base/Contract';
import { AbiMessage, ContractCallOutcome } from '@polkadot/api-contract/types';
import { ResultsOutput } from './ResultsOutput';
import { AccountSelect } from 'ui/components/account';
import { Dropdown, Button, Buttons } from 'ui/components/common';
import {
  ArgumentForm,
  InputGas,
  InputBalance,
  InputStorageDepositLimit,
  Form,
  FormField,
} from 'ui/components/form';
import { transformUserInput, BN_ZERO } from 'helpers';
import { useApi, useTransactions } from 'ui/contexts';
import { CallResult, ContractPromise, SubmittableResult } from 'types';
import { useWeight, useBalance, useArgValues } from 'ui/hooks';
import { useToggle } from 'ui/hooks/useToggle';
import { useStorageDepositLimit } from 'ui/hooks/useStorageDepositLimit';
import { createMessageOptions } from 'ui/util/dropdown';

interface Props {
  contract: ContractPromise;
}

export const InteractTab = ({ contract }: Props) => {
  const { accounts, api } = useApi();
  const { queue, process, txs } = useTransactions();
  const [message, setMessage] = useState<AbiMessage>();
  const [argValues, setArgValues] = useArgValues(message?.args || [], contract.abi.registry);
  const [callResults, setCallResults] = useState<CallResult[]>([]);
  const { value, onChange: setValue, ...valueValidation } = useBalance(0);
  const [accountId, setAccountId] = useState('');
  const [txId, setTxId] = useState<number>(0);
  const [nextResultId, setNextResultId] = useState(1);
  const [isUsingStorageDepositLimit, toggleIsUsingStorageDepositLimit] = useToggle();
  const [outcome, setOutcome] = useState<ContractCallOutcome>();
  const storageDepositLimit = useStorageDepositLimit(accountId);
  const weight = useWeight(outcome?.gasRequired);
  const timeoutId = useRef<NodeJS.Timeout | null>(null);

  const inputData = useMemo(() => {
    return message ? transformUserInput(contract.registry, message.args, argValues) : [];
  }, [argValues, contract.registry, message]);

  useEffect((): void => {
    if (!accounts || accounts.length === 0) return;
    setAccountId(accounts[0].address);
  }, [accounts]);

  useEffect(() => {
    setMessage(contract.abi.messages[0]);
    setOutcome(undefined);
    // todo: call results storage
    setCallResults([]);
  }, [contract.abi.messages]);

  useEffect((): void => {
    async function dryRun() {
      if (!message || typeof contract.query[message.method] !== 'function') return;

      const o = await contract.query[message.method](
        accountId,
        {
          gasLimit: weight.mode === 'custom' ? weight.megaGas : -1,
          storageDepositLimit: isUsingStorageDepositLimit ? storageDepositLimit.value : null,
        },
        ...inputData
      );
      setOutcome(o);
    }

    function debouncedDryRun() {
      if (timeoutId.current) clearTimeout(timeoutId.current);
      timeoutId.current = setTimeout(() => {
        dryRun().catch(err => console.error(err));
        timeoutId.current = null;
      }, 300);
    }

    debouncedDryRun();
  }, [
    accountId,
    contract.query,
    isUsingStorageDepositLimit,
    message,
    inputData,
    storageDepositLimit.value,
    weight.megaGas,
    weight.mode,
  ]);

  useEffect(() => {
    async function processTx() {
      txs[txId]?.status === 'queued' && (await process(txId));
    }
    processTx().catch(e => console.error(e));
  }, [process, txId, txs]);

  const onCallSuccess = ({ events, contractEvents, dispatchError }: ContractSubmittableResult) => {
    message &&
      setCallResults([
        ...callResults,
        {
          id: nextResultId,
          message,
          time: Date.now(),
          contractEvents,
          events,
          error: dispatchError?.isModule
            ? api.registry.findMetaError(dispatchError.asModule)
            : undefined,
        },
      ]);

    setNextResultId(nextResultId + 1);
  };

  const newId = useRef<number>();

  const call = () => {
    const { storageDeposit, gasRequired } = outcome ?? {};
    const options = {
      gasLimit: weight.mode === 'custom' ? weight.megaGas : gasRequired ?? weight.defaultWeight,
      storageDepositLimit: isUsingStorageDepositLimit
        ? storageDepositLimit.value
        : storageDeposit?.isCharge
        ? storageDeposit?.asCharge
        : undefined,
      value: message?.isPayable ? value || BN_ZERO : undefined,
    };

    const isValid = (result: SubmittableResult) => !result.isError && !result.dispatchError;

    const tx = message && contract.tx[message.method](options, ...inputData);

    if (tx && accountId) {
      newId.current = queue({
        extrinsic: tx,
        accountId,
        onSuccess: onCallSuccess,
        isValid,
      });
      setTxId(newId.current);
    }
  };

  const decodedOutput = outcome?.output?.toHuman();

  const callDisabled =
    !weight.isValid ||
    txs[txId]?.status === 'processing' ||
    !!outcome?.result.isErr ||
    (!!decodedOutput && typeof decodedOutput === 'object' && 'Err' in decodedOutput);

  if (!contract) return null;

  return (
    <div className="grid grid-cols-12 w-full">
      <div className="col-span-6 lg:col-span-6 2xl:col-span-7 rounded-lg w-full">
        <Form key={`${contract.address}`}>
          <FormField
            className="mb-8 caller"
            help="The sending account for this interaction. Any transaction fees will be deducted from this account."
            id="accountId"
            label="Account"
          >
            <AccountSelect
              id="accountId"
              className="mb-2"
              value={accountId}
              onChange={setAccountId}
            />
          </FormField>
          <FormField
            help="The message to send to this contract. Parameters are adjusted based on the stored contract metadata."
            id="message"
            label="Message to Send"
          >
            <Dropdown
              id="message"
              options={createMessageOptions(contract.abi.registry, contract.abi.messages)}
              className="constructorDropdown mb-4"
              onChange={(m?: AbiMessage) => {
                m?.identifier !== message?.identifier && setOutcome(undefined);
                setMessage(m);
              }}
              value={message}
            >
              No messages found
            </Dropdown>
            {argValues && (
              <ArgumentForm
                args={message?.args ?? []}
                registry={contract.abi.registry}
                setArgValues={setArgValues}
                argValues={argValues}
              />
            )}
          </FormField>

          {message?.isPayable && (
            <FormField
              help="The balance to transfer to the contract as part of this call."
              id="value"
              label="Payment"
              {...valueValidation}
            >
              <InputBalance value={value} onChange={setValue} placeholder="Value" />
            </FormField>
          )}
          {(message?.isMutating || message?.isPayable) && (
            <div className="flex justify-between">
              <FormField
                help="The maximum amount of gas (in millions of units) to use for this contract call. If the call requires more, it will fail."
                id="maxGas"
                label="Max Gas Allowed"
                isError={!weight.isValid}
                message={!weight.isValid ? 'Invalid gas limit' : null}
                className="basis-2/4 mr-4"
              >
                <InputGas
                  estimatedWeight={weight.estimatedWeight}
                  megaGas={weight.megaGas}
                  setMegaGas={weight.setMegaGas}
                  defaultWeight={weight.defaultWeight}
                  isValid={weight.isValid}
                  mode={weight.mode}
                  setMode={weight.setMode}
                />
              </FormField>
              <FormField
                help="The maximum balance allowed to be deducted from the sender account for any additional storage deposit."
                id="storageDepositLimit"
                label="Storage Deposit Limit"
                isError={!storageDepositLimit.isValid}
                message={
                  !storageDepositLimit.isValid
                    ? storageDepositLimit.message || 'Invalid storage deposit limit'
                    : null
                }
                className="basis-2/4 shrink-0"
              >
                <InputStorageDepositLimit
                  isActive={isUsingStorageDepositLimit}
                  toggleIsActive={toggleIsUsingStorageDepositLimit}
                  {...storageDepositLimit}
                />
              </FormField>
            </div>
          )}
        </Form>
        <Buttons>
          {(message?.isPayable || message?.isMutating) && (
            <Button
              isDisabled={callDisabled}
              isLoading={txs[txId]?.status === 'processing'}
              onClick={call}
              variant="primary"
            >
              Call contract
            </Button>
          )}
        </Buttons>
      </div>
      <div className="col-span-6 lg:col-span-6 2xl:col-span-5 pl-10 lg:pl-20 w-full">
        {message && (
          <ResultsOutput
            registry={contract.registry}
            results={callResults}
            outcome={outcome}
            message={message}
          />
        )}
      </div>
    </div>
  );
};
