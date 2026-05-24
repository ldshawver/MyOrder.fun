import { forwardRef } from "react";

const Homepage = forwardRef<HTMLDivElement, Record<string, unknown>>(
  function Homepage(_props, ref) {
    return (
      <div ref={ref} style={{ padding: "2rem", textAlign: "center" }}>
        <h1>Plasmic Homepage</h1>
        <p>Replace this with your Plasmic-generated component.</p>
      </div>
    );
  }
);

Homepage.displayName = "Homepage";

export default Homepage;
