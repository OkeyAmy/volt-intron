"use client";

export default function PrintButton() {
  return (
    <button className="sr-btn sr-ghost inv-noprint" onClick={() => window.print()}>
      Print / Save as PDF
    </button>
  );
}
