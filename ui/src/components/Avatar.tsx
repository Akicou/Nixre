import React from 'react';

interface AvatarProps {
  name?: string | null;
  url?: string | null;
  size?: number;
  className?: string;
  shape?: 'circle' | 'square';
}

// Renders an uploaded avatar image if `url` is set, otherwise a generated
// initials badge (the existing behavior across the app).
export const Avatar: React.FC<AvatarProps> = ({ name, url, size = 32, className = '', shape = 'circle' }) => {
  const shapeClass = shape === 'circle' ? 'rounded-full' : 'rounded-md';
  const boxStyle: React.CSSProperties = { width: size, height: size };

  if (url) {
    return (
      <img
        src={url}
        alt={name || ''}
        width={size}
        height={size}
        className={`${shapeClass} object-cover bg-surface-subtle border border-border-subtle shrink-0 ${className}`}
        style={boxStyle}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <div
      className={`${shapeClass} bg-surface-subtle border border-border-subtle flex items-center justify-center font-bold text-txt-primary shrink-0 ${className}`}
      style={{ ...boxStyle, fontSize: Math.round(size * 0.4) }}
      aria-label={name || 'avatar'}
    >
      {(name || '?').slice(0, 2).toUpperCase()}
    </div>
  );
};
