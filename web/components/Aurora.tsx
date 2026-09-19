/** The green aurora: a textured base with bold drifting light-blobs, scrim, vignette, grain. */
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
