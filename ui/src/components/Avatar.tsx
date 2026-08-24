import React, { useEffect, useState } from 'react';

interface AvatarProps {
  name?: string | null;
  url?: string | null;
  size?: number;
  className?: string;
  shape?: 'circle' | 'square';
  fill?: boolean;
}

// Renders an uploaded avatar image if `url` is set, otherwise a generated
// initials badge (the existing behavior across the app).
export const Avatar: React.FC<AvatarProps> = ({ name, url, size = 32, className = '', shape = 'circle', fill = false }) => {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [url]);
  const shapeClass = shape === 'circle' ? 'rounded-full' : 'rounded-md';
  const boxStyle: React.CSSProperties = fill
    ? { width: '100%', height: '100%' }
    : { width: size, height: size };
  const fontSize = fill ? undefined : Math.round(size * 0.4);

  if (url && !broken) {
    return (
      <img
        src={url}
        alt={name || ''}
        width={fill ? undefined : size}
        height={fill ? undefined : size}
        className={`${shapeClass} object-cover bg-surface-subtle border border-border-subtle shrink-0 ${className}`}
        style={boxStyle}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }

  return (
    <div
      className={`${shapeClass} bg-surface-subtle border border-border-subtle flex items-center justify-center font-bold text-txt-primary shrink-0 ${fill ? 'text-2xl lg:text-8xl' : ''} ${className}`}
      style={{ ...boxStyle, fontSize }}
      aria-label={name || 'avatar'}
    >
      {(name || '?').slice(0, 2).toUpperCase()}
    </div>
  );
};
