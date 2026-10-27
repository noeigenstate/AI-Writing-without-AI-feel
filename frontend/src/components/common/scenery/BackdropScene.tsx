/** Soft sky wash behind the hero and a painted meadow strip at the foot of the page. Decorative only. */
export default function BackdropScene() {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="backdrop-sky" />
      <span className="backdrop-meadow" />
    </div>
  );
}
