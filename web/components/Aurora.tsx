/** The moving purple aurora background (recreated from the reference, license-safe): drifting
 *  blobs on a deep-indigo base, plus scrim, vignette, and film grain. Purely decorative. */
export default function Aurora() {
  return (
    <div aria-hidden>
      <div className="bg-layer aurora">
        <span className="blob blob-1" />
        <span className="blob blob-2" />
        <span className="blob blob-3" />
        <span className="blob blob-4" />
      </div>
      <div className="bg-layer scrim" />
      <div className="bg-layer vignette" />
      <div className="bg-layer grain" />
    </div>
  );
}
