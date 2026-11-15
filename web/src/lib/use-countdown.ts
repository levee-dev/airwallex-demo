import { useEffect, useState } from 'react';

/** Live m:ss countdown to an ISO time. */
export function useCountdown(iso: string): { text: string; expired: boolean } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  const left = Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
  return { text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, expired: left === 0 };
}
