import React from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';

/**
 * "N ahead / N behind" readout, shared by the branch list and the PR detail.
 *
 * ahead  = commits this branch has that its base does not
 * behind = commits the base has that this branch does not
 *
 * Renders nothing when the backend did not send the counts (older API, or a
 * list route that does not compute them).
 */
export const Divergence: React.FC<{ ahead?: number; behind?: number; className?: string }> = ({
  ahead,
  behind,
  className = '',
}) => {
  if (typeof ahead !== 'number' && typeof behind !== 'number') return null;
  const a = ahead ?? 0;
  const b = behind ?? 0;
  if (a === 0 && b === 0) {
    return <span className={`font-mono text-xs text-txt-tertiary ${className}`}>up to date</span>;
  }
  return (
    <span className={`flex items-center gap-2 font-mono text-xs ${className}`}>
      {a > 0 && (
        <span className="flex items-center gap-0.5 text-txt-open" title={`${a} commit(s) ahead`}>
          <ArrowUp className="w-3 h-3" />
          {a} ahead
        </span>
      )}
      {b > 0 && (
        <span className="flex items-center gap-0.5 text-txt-tertiary" title={`${b} commit(s) behind`}>
          <ArrowDown className="w-3 h-3" />
          {b} behind
        </span>
      )}
    </span>
  );
};
