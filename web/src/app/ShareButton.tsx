"use client";

/**
 * Share an issued invoice's link: the native share sheet where there is one,
 * otherwise the clipboard, otherwise the link itself to copy by hand.
 */
import { useCallback, useState } from "react";

export default function ShareButton({ id, number, className = "sr-btn sr-ghost" }: { id: string; number: string; className?: string }) {
  const [note, setNote] = useState("");

  const share = useCallback(async () => {
    const url = `${location.origin}/invoice/${id}`;
    const text = `Invoice ${number} from Sautice`;
    try {
      if (navigator.share) {
        await navigator.share({ title: text, text, url });
        setNote("Share sheet opened. Sharing isn't confirmed until you send it.");
        return;
      }
      await navigator.clipboard.writeText(url);
      setNote("Invoice link copied. Paste it wherever you want to send it.");
    } catch (e) {
      // Closing the share sheet is not an error worth reporting.
      if ((e as Error).name === "AbortError") return;
      setNote(`Copy this link to share: ${url}`);
    }
  }, [id, number]);

  return (
    <>
      <button type="button" className={className} onClick={share}>Share invoice</button>
      {note && <p className="sr-meta share-note" role="status">{note}</p>}
    </>
  );
}
