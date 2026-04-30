import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, FileImage, AlertCircle, CheckCircle2, Camera } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogBody, DialogFooter,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { useUploadDocument } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { cn } from "@/lib/cn";

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"];

export function UploadDialog({ open, onOpenChange }) {
  const orgId = useOrgStore((s) => s.activeOrgId);
  const navigate = useNavigate();
  const upload = useUploadDocument(orgId);
  const [dragOver, setDragOver] = useState(false);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const cameraRef = useRef(null);

  const reset = () => {
    setSelected(null);
    setError(null);
  };

  const validateFile = useCallback((f) => {
    if (f.size > MAX_BYTES) return `File is over 10 MB (${(f.size / 1024 / 1024).toFixed(1)} MB).`;
    if (!ACCEPT.includes(f.type)) return `Type not supported: ${f.type || "unknown"}. Use JPEG, PNG, WebP, HEIC, or PDF.`;
    return null;
  }, []);

  const onPick = (f) => {
    if (!f) return;
    const err = validateFile(f);
    if (err) {
      setError(err);
      setSelected(null);
      return;
    }
    setError(null);
    setSelected(f);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    onPick(f);
  };

  const submit = () => {
    if (!selected) return;
    upload.mutate({ file: selected }, {
      onSuccess: (doc) => {
        toast.success("Receipt uploaded", {
          description: doc.merchant
            ? `Extracted ${doc.merchant}`
            : doc.extraction_error
              ? "Saved — extraction will retry"
              : "Saved",
          action: { label: "View", onClick: () => navigate(`/receipts/${doc.id}`) },
        });
        reset();
        onOpenChange(false);
      },
      onError: (e) => {
        setError(e.message);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload receipt</DialogTitle>
          <DialogDescription>
            We'll extract merchant, total, line items, and tax automatically.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT.join(",")}
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0])}
          />

          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            className={cn(
              "rounded-lg border-2 border-dashed cursor-pointer transition-all duration-150",
              "px-6 py-10 text-center",
              dragOver
                ? "border-accent-ring bg-accent-muted/30"
                : "border-ink-200 hover:border-ink-300 hover:bg-ink-50",
            )}
          >
            {selected ? (
              <div className="flex flex-col items-center gap-3">
                <div className="h-12 w-12 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600">
                  <CheckCircle2 size={20} />
                </div>
                <div>
                  <div className="text-sm font-medium tracking-tight text-ink-900 break-all">{selected.name}</div>
                  <div className="text-[12px] text-ink-500 mt-0.5 tnum">
                    {(selected.size / 1024).toFixed(0)} KB · {selected.type || "image"}
                  </div>
                </div>
                <button
                  className="text-[12px] text-ink-500 hover:text-ink-900 underline underline-offset-2"
                  onClick={(e) => { e.stopPropagation(); reset(); inputRef.current?.click(); }}
                >
                  Choose a different file
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className={cn(
                  "h-12 w-12 rounded-lg flex items-center justify-center transition-colors",
                  dragOver ? "bg-accent text-accent-fg" : "bg-ink-100 text-ink-500",
                )}>
                  {dragOver ? <FileImage size={20} /> : <Upload size={20} />}
                </div>
                <div>
                  <div className="text-sm font-medium tracking-tight text-ink-900">
                    {dragOver ? "Drop to upload" : "Drag a file here, or click to browse"}
                  </div>
                  <div className="text-[12px] text-ink-500 mt-1">
                    JPEG, PNG, WebP, HEIC, or PDF · up to 10 MB
                  </div>
                </div>
              </div>
            )}
          </div>

          {!selected && (
            <div className="mt-3 sm:hidden">
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-md border border-ink-200 bg-ink-0 text-sm font-medium tracking-tight text-ink-900 hover:bg-ink-50 active:bg-ink-100 transition-colors"
              >
                <Camera size={16} /> Take a photo
              </button>
              <p className="mt-2 text-center text-[11px] text-ink-400">
                Opens your camera — best for capturing a slip on the spot.
              </p>
            </div>
          )}

          {error && (
            <div className="mt-3 flex items-start gap-2 text-[13px] text-danger animate-fade-in">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="accent" onClick={submit} disabled={!selected || upload.isPending} loading={upload.isPending}>
            {upload.isPending ? "Extracting…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
