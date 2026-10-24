"use client";

import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface SetupCardProps {
  title: string;
  docLink?: string;
  className?: string;
  onClick?: () => void;
  isActive: boolean;
}

export function SetupCard({
  title,
  docLink,
  className,
  onClick,
  isActive,
}: SetupCardProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md text-sm transition-colors",
        !isActive ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      <button
        type="button"
        aria-current={isActive ? "step" : undefined}
        className="flex-1 min-w-0 py-1.5 px-2 text-left cursor-pointer rounded-md"
        onClick={onClick}
      >
        <span className="truncate">{title}</span>
      </button>
      {docLink && (
        <Link href={docLink} target="_blank" className="ml-auto p-2">
          <ExternalLink className="h-3 w-3 text-muted-foreground hover:text-foreground" />
          <span className="sr-only">Documentation</span>
        </Link>
      )}
    </div>
  );
}
