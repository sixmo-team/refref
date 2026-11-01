"use client";

import { useState, useRef } from "react";
import { api } from "@/trpc/react";
import { Button } from "@refref/ui/components/button";
import { Input } from "@refref/ui/components/input";
import { Label } from "@refref/ui/components/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@refref/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@refref/ui/components/select";
import { toast } from "sonner";
import { Copy, CheckCircle, AlertCircle, Eye, EyeOff } from "lucide-react";
import { Alert, AlertDescription } from "@refref/ui/components/alert";

interface CreateOrgApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateOrgApiKeyDialog({
  open,
  onOpenChange,
}: CreateOrgApiKeyDialogProps) {
  const [name, setName] = useState("");
  const [expiresIn, setExpiresIn] = useState("0"); // Never (default)
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [dedicated, setDedicated] = useState(false);
  const [productId, setProductId] = useState("");
  const [programId, setProgramId] = useState("");
  const creating = useRef(false);

  const utils = api.useUtils();

  const createKeyMutation = api.apiKeys.create.useMutation({
    onSuccess: (data) => {
      if (data?.key) {
        setCreatedKey(data.key);
        toast.success("API key created successfully");
      }
      utils.apiKeys.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create API key");
    },
  });

  const handleCreate = () => {
    if (creating.current) return;
    if (dedicated && (!productId.trim() || !programId.trim())) {
      toast.error("Explicit authorized product and program IDs are required");
      return;
    }
    if (!name.trim()) {
      toast.error("Please enter a name for the API key");
      return;
    }

    creating.current = true;
    createKeyMutation.mutate(
      {
        name,
        expiresIn: parseInt(expiresIn),
        ...(dedicated
          ? {
              referralScope: {
                productId: productId.trim(),
                programId: programId.trim(),
              },
            }
          : {}),
      },
      {
        onSettled: () => {
          creating.current = false;
        },
      },
    );
  };

  const handleCopyKey = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      toast.success("API key copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy API key");
    }
  };

  const handleClose = () => {
    setName("");
    setExpiresIn("0");
    setDedicated(false);
    setProductId("");
    setProgramId("");
    setCreatedKey(null);
    setCopied(false);
    setShowKey(false);
    onOpenChange(false);
  };

  // If we're showing the created key, show a different UI
  if (createdKey) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>API Key Created Successfully</DialogTitle>
            <DialogDescription>
              Copy your API key now. You won&apos;t be able to see it again!
            </DialogDescription>
          </DialogHeader>

          <Alert className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Make sure to copy your API key now. For security reasons, we
              won&apos;t show it again.
            </AlertDescription>
          </Alert>

          <div className="space-y-4">
            <div>
              <Label htmlFor="created-api-key">Your API Key</Label>
              <div className="flex items-center gap-2 mt-2">
                <div className="relative flex-1">
                  <Input
                    id="created-api-key"
                    readOnly
                    type={showKey ? "text" : "password"}
                    value={createdKey}
                    className="pr-10 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyKey}
                  className="flex-shrink-0"
                >
                  {copied ? (
                    <>
                      <CheckCircle className="h-4 w-4 mr-2 text-green-600" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-2" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
            </div>
            <Alert>
              <AlertDescription>
                {createKeyMutation.variables?.referralScope
                  ? "This key is restricted to first-payment resolution and purchase for the chosen product and program."
                  : "This key has full access to your organization's products and programs."}
              </AlertDescription>
            </Alert>
          </div>

          <DialogFooter>
            <Button onClick={handleClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Organization API Key</DialogTitle>
          <DialogDescription>
            Create an organization key, or restrict it to protected
            first-payment resolution and purchase for one explicitly authorized
            product/program.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              placeholder="e.g., Production API Key"
              maxLength={32}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A descriptive name, up to 32 characters
            </p>
          </div>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={dedicated}
              onChange={(e) => setDedicated(e.target.checked)}
            />
            Dedicated first-payment integration
          </label>
          {dedicated && (
            <div className="space-y-2">
              <Label htmlFor="referral-product">Authorized product ID</Label>
              <Input
                id="referral-product"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
              />
              <Label htmlFor="referral-program">Authorized program ID</Label>
              <Input
                id="referral-program"
                value={programId}
                onChange={(e) => setProgramId(e.target.value)}
              />
              <p className="text-xs">
                No first-product fallback. The server checks
                organization/product/program ownership.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="expiry">Expiry</Label>
            <Select value={expiresIn} onValueChange={setExpiresIn}>
              <SelectTrigger id="expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="2592000">30 days</SelectItem>
                <SelectItem value="7776000">90 days</SelectItem>
                <SelectItem value="15552000">180 days</SelectItem>
                <SelectItem value="31536000">1 year</SelectItem>
                <SelectItem value="63072000">2 years</SelectItem>
                <SelectItem value="0">Never</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              When this key should expire and become invalid
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={createKeyMutation.isPending}>
            {createKeyMutation.isPending ? "Creating..." : "Create Key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
