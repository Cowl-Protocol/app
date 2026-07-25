"use client";

import { formatUnits } from "viem";
import type { Asset } from "@/lib/assets";
import { displayName, isTokenized } from "@/lib/assets";
import { formatBalance, usdOf } from "@/lib/prices";
import { TokenGlyph } from "./TokenModal";

// One row for one asset, wherever assets are listed.
//
// The picker and the portfolio want the same facts in the same order — mark,
// name, what it is, how much, what that is worth — and differ only in whether
// the row is something you press. Keeping one component means a fix to how a
// balance or a tokenized name reads lands on both at once.

type Props = {
  asset: Asset;
  /** Present for a picker row; absent for a list that only displays. */
  onPick?: (asset: Asset) => void;
  /** Show the contract address under the name, as a picker does. */
  showAddress?: boolean;
  /** Right-hand fallback when the wallet holds none of it, e.g. a holder count. */
  trailing?: string;
};

export default function AssetRow({ asset, onPick, showAddress, trailing }: Props) {
  const { token, balance, price } = asset;
  const amount = balance === null ? null : formatUnits(balance, token.decimals);
  const usd = amount === null ? null : usdOf(parseFloat(amount), price);

  const body = (
    <>
      <TokenGlyph symbol={token.symbol} src={token.logoURI} />
      <span className="flex flex-col flex-1 min-w-0">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-bone truncate">{displayName(token.name)}</span>
          {isTokenized(token.name) && (
            <span className="label-soft text-[0.55rem] text-acid bg-[#161a10] px-1.5 py-0.5 shrink-0">RWA</span>
          )}
        </span>
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-faint">{token.symbol}</span>
          {showAddress && !token.native && (
            <span className="font-data text-[0.65rem] text-faint/70 truncate">
              {token.address.slice(0, 6)}…{token.address.slice(-4)}
            </span>
          )}
        </span>
      </span>
      <span className="flex flex-col items-end shrink-0">
        {amount === null ? (
          <span className="font-data text-xs text-faint">unavailable</span>
        ) : (
          <>
            <span className="font-data text-sm text-bone">{formatBalance(amount)}</span>
            {usd && <span className="text-xs text-faint font-data">{usd}</span>}
            {!usd && trailing && <span className="text-[0.68rem] text-faint font-data">{trailing}</span>}
          </>
        )}
      </span>
    </>
  );

  if (!onPick) {
    return <div className="flex items-center gap-3 px-1 py-3">{body}</div>;
  }
  return (
    <button
      onClick={() => onPick(asset)}
      className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-ink3 transition-colors text-left"
    >
      {body}
    </button>
  );
}
