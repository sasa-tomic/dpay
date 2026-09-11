import {useEffect, useState} from 'react';
import {type TxNote, loadTxNotes, subscribeTxNotes, txNoteIndex} from '../services/txNotes';

// Authority: the read half of the payment-context annotation store (services/txNotes) — loads one
// identity's notes and re-reads whenever `saveTxNote` announces a change for that identity (a
// payment made seconds after boot must annotate its rows the moment the history poll surfaces
// them). The hook deliberately has NO failure state: a store that will not load degrades to an
// empty map and the rows render exactly as they did before this store existed. The `alive` guard
// discards a stale load's result across identity changes; a notification racing an in-flight read
// is harmless — both paths converge on the same persisted state.
export function useTxNotes(publicHex: string): ReadonlyMap<string, TxNote> {
  const [index, setIndex] = useState<ReadonlyMap<string, TxNote>>(() => new Map());
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const entries = await loadTxNotes(publicHex);
      if (alive) setIndex(txNoteIndex(entries));
    };
    void read();
    const off = subscribeTxNotes(changed => {
      if (changed === publicHex) void read();
    });
    return () => {
      alive = false;
      off();
    };
  }, [publicHex]);
  return index;
}
