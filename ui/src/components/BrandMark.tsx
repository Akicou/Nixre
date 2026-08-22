import React from 'react';

const MARK_URL = '/nixre-mark.png';

type BrandMarkSize = 'sm' | 'md' | 'lg';

const sizeClass: Record<BrandMarkSize, string> = {
  sm: 'w-7 h-7',
  md: 'w-10 h-10',
  lg: 'w-12 h-12',
};

interface BrandMarkProps {
  size?: BrandMarkSize;
  className?: string;
  /** Empty string when decorative (e.g. next to visible "Nixre" text). */
  alt?: string;
}

export const BrandMark: React.FC<BrandMarkProps> = ({
  size = 'md',
  className = '',
  alt = 'Nixre',
}) => (
  <img
    src={MARK_URL}
    alt={alt}
    className={`${sizeClass[size]} object-contain shrink-0 ${className}`}
    decoding="async"
  />
);
