"use client";

// Custom global error boundary. Providing our own overrides Next's built-in
// `/_global-error` page, whose static prerender otherwise fails the production
// build (`next build`) with `Cannot read properties of null (reading
// 'useContext')`. It replaces the root layout on a top-level crash, so it must
// render its own <html>/<body> and stay free of context/providers.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#09090b",
          color: "#fafafa",
        }}
      >
        <div style={{ maxWidth: "28rem", padding: "1.5rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            Something went wrong
          </h1>
          <p style={{ opacity: 0.7, fontSize: "0.875rem", marginBottom: "1.25rem" }}>
            The admin app hit an unexpected error.
            {error?.digest ? ` (ref: ${error.digest})` : ""}
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              borderRadius: "0.375rem",
              border: "1px solid #3f3f46",
              background: "#18181b",
              color: "#fafafa",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
