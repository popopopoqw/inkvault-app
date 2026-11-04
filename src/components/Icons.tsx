// 统一的线性图标（lucide 风格：24 viewBox、stroke 描边、currentColor）
import type { ReactNode, SVGProps } from 'react';

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconDoc = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M14.5 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
    <path d="M14 3v5h5" />
  </Icon>
);

export const IconFolder = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 20a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2.4 3H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z" />
  </Icon>
);

export const IconFolderOpen = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 20a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2.4 3H20a2 2 0 0 1 2 2v1.5" />
    <path d="M2.5 12.5h19l-1.6 6a2 2 0 0 1-1.95 1.5H4z" />
  </Icon>
);

export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconFolderPlus = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 20a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2.4 3H20a2 2 0 0 1 2 2v2" />
    <path d="M2.5 12.5H9" />
    <path d="M15 13v6M12 16h6" />
    <path d="M2.5 12.5 4 19a2 2 0 0 0 2 1.9h5" />
  </Icon>
);

export const IconPencil = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </Icon>
);

export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6M14 11v6" />
  </Icon>
);

export const IconEye = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const IconLogout = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Icon>
);

export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);

export const IconChevronDown = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const IconLink = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Icon>
);

export const IconQuote = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M10 11H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4" />
    <path d="M20 11h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4" />
  </Icon>
);

export const IconList = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M9 6h12M9 12h12M9 18h12" />
    <path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth="2.4" />
  </Icon>
);

export const IconTask = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="m8.5 12 2.5 2.5 4.5-4.5" />
  </Icon>
);

export const IconTable = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M12 3v18" />
  </Icon>
);

export const IconCode = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
  </Icon>
);

export const IconCodeInline = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m13 8 4 4-4 4M11 16l-4-4 4-4" />
  </Icon>
);

export const IconImage = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="1.6" />
    <path d="m21 15.5-3.6-3.6a2 2 0 0 0-2.8 0L6 21" />
  </Icon>
);

// 品牌 logo：渐变方底 + 白色墨滴描边 + 锁孔
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="inkvault-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6d6af7" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#inkvault-g)" />
      <path
        d="M24 8.5c4.6 6.9 8.6 11 8.6 16.1a8.6 8.6 0 1 1-17.2 0C15.4 19.5 19.4 15.4 24 8.5Z"
        fill="none"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="23.2" r="2.5" fill="#fff" />
      <rect x="22.85" y="24.4" width="2.3" height="4.6" rx="1.15" fill="#fff" />
    </svg>
  );
}
