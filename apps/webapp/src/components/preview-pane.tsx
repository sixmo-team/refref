"use client";

import type * as React from "react";

import { cn } from "@/lib/utils";
import { ScrollArea } from "@refref/ui/components/scroll-area";

interface PreviewPaneProps extends React.HTMLAttributes<HTMLDivElement> {
  isOpen?: boolean;
  onClose?: () => void;
  children?: React.ReactNode;
}

export function PreviewPane({
  className,
  isOpen = true,
  children,
  ...props
}: PreviewPaneProps) {
  if (!isOpen) return null;
  delete props.onClose;

  return (
    <div
      className={cn(
        "flex h-full w-xl flex-col border-l bg-muted/40",
        className,
      )}
      {...props}
    >
      <ScrollArea className="flex-1">
        <div className="p-4">{children}</div>
      </ScrollArea>
    </div>
  );
}
