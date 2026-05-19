"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, FileJson, FileText, Loader2, UploadCloud } from "lucide-react";
import type { ScanResponse } from "@/app/api/scan/route";
import ResultsDashboard from "@/components/ResultsDashboard";

type ScanState = "idle" | "scanning" | "done" | "error";

const acceptedFiles = ["package.json", "requirements.txt"];

export default function ScanPage() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const progressTimer = useRef<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<ScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isScanning = scanState === "scanning";

  const stopProgress = useCallback(() => {
    if (progressTimer.current) {
      window.clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
  }, []);

  useEffect(() => stopProgress, [stopProgress]);

  const startProgress = useCallback(() => {
    stopProgress();
    setProgress(8);
    progressTimer.current = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 92) return current;
        const increment = current < 40 ? 8 : current < 70 ? 5 : 2;
        return Math.min(92, current + increment);
      });
    }, 450);
  }, [stopProgress]);

  const validateFile = (file: File) => {
    if (acceptedFiles.includes(file.name)) return null;
    return "Upload a package.json or requirements.txt file.";
  };

  const scanFile = useCallback(
    async (file: File) => {
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        setScanState("error");
        return;
      }

      setError(null);
      setResults(null);
      setScanState("scanning");
      startProgress();

      try {
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch("/api/scan", {
          method: "POST",
          body: formData,
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "The scan could not be completed.");
        }

        stopProgress();
        setProgress(100);

        window.setTimeout(() => {
          setResults(payload as ScanResponse);
          setScanState("done");
        }, 250);
      } catch (scanError) {
        stopProgress();
        setProgress(0);
        setScanState("error");
        setError(
          scanError instanceof Error
            ? scanError.message
            : "Something went wrong while scanning the file."
        );
      } finally {
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [startProgress, stopProgress]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      setIsDragging(false);
      if (isScanning) return;

      const file = event.dataTransfer.files.item(0);
      if (file) void scanFile(file);
    },
    [isScanning, scanFile]
  );

  const handleFileInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.item(0);
      if (file) void scanFile(file);
    },
    [scanFile]
  );

  if (results) {
    return (
      <ResultsDashboard
        data={results}
        onReset={() => {
          setResults(null);
          setScanState("idle");
          setProgress(0);
          setError(null);
        }}
      />
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 py-8 text-zinc-100">
      <section className="w-full max-w-xl rounded-lg border border-zinc-800 bg-zinc-900/80 p-6 shadow-2xl shadow-black/30 sm:p-8">
        <div className="mb-7 text-center">
          <div className="mb-4 text-5xl" aria-hidden="true">
            ⚰️
          </div>
          <h1 className="text-3xl font-semibold text-white">Dependency Obituary</h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-zinc-400">
            Upload a dependency file to score package health across releases,
            maintainers, GitHub activity, issues, and downloads.
          </p>
        </div>

        <div
          onDragEnter={(event) => {
            event.preventDefault();
            if (!isScanning) setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node)) return;
            setIsDragging(false);
          }}
          onDrop={handleDrop}
          className={`w-full rounded-lg border border-dashed p-5 transition-colors sm:p-6 ${
            isDragging
              ? "border-orange-400 bg-orange-950/20"
              : "border-zinc-700 bg-zinc-900/60"
          } ${isScanning ? "cursor-wait opacity-90" : "cursor-pointer hover:border-zinc-500"}`}
          role="button"
          tabIndex={0}
          onClick={() => {
            if (!isScanning) inputRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (!isScanning && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".json,.txt,application/json,text/plain"
            className="sr-only"
            onChange={handleFileInput}
          />

          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-zinc-800">
                {isScanning ? (
                  <Loader2 className="h-6 w-6 animate-spin text-orange-400" aria-hidden="true" />
                ) : (
                  <UploadCloud className="h-6 w-6 text-orange-400" aria-hidden="true" />
                )}
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {isScanning ? "Scanning dependencies" : "Drop your dependency file"}
                </h2>
                <p className="mt-1 text-sm leading-6 text-zinc-400">
                  Accepts package.json and requirements.txt.
                </p>
                <div className="mt-4 flex flex-wrap gap-2 text-xs text-zinc-400">
                  <span className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1">
                    <FileJson className="h-3.5 w-3.5" aria-hidden="true" />
                    package.json
                  </span>
                  <span className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1">
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                    requirements.txt
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              disabled={isScanning}
              onClick={(event) => {
                event.stopPropagation();
                inputRef.current?.click();
              }}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md bg-orange-500 px-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              <UploadCloud className="h-4 w-4" aria-hidden="true" />
              Select file
            </button>
          </div>

          {isScanning && (
            <div className="mt-7">
              <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-orange-500 transition-all duration-500 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
                <span>Calling scan API</span>
                <span>{Math.round(progress)}%</span>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-3 rounded-lg border border-red-900/80 bg-red-950/30 px-4 py-3 text-sm text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
            <div>
              <p className="font-medium text-red-100">Scan failed</p>
              <p className="mt-1 text-red-200/80">{error}</p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
