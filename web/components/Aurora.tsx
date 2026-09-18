/** The supplied green-light background with restrained motion, scrim, vignette, and grain. */
export default function Aurora() {
  return (
    <div aria-hidden>
      <div className="bg-layer aurora">
      </div>
      <div className="bg-layer scrim" />
      <div className="bg-layer vignette" />
      <div className="bg-layer grain" />
    </div>
  );
}
