interface SessionWatermarkProps {
  email: string;
}

export default function SessionWatermark({ email }: SessionWatermarkProps) {
  const label = `${email} · CONFIDENTIAL`;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[100] select-none overflow-hidden"
      style={{ opacity: 0.045 }}
    >
      <div
        style={{
          position: "absolute",
          inset: "-50%",
          width: "200%",
          height: "200%",
          transform: "rotate(-30deg)",
          display: "flex",
          flexDirection: "column",
          gap: "64px",
          justifyContent: "flex-start",
          alignItems: "flex-start",
        }}
      >
        {Array.from({ length: 20 }).map((_, row) => (
          <div
            key={row}
            style={{
              display: "flex",
              gap: "120px",
              whiteSpace: "nowrap",
              marginLeft: row % 2 === 0 ? "0px" : "-160px",
            }}
          >
            {Array.from({ length: 8 }).map((_, col) => (
              <span
                key={col}
                style={{
                  fontFamily: "monospace",
                  fontSize: "11px",
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  color: "#DC143C",
                  textTransform: "uppercase",
                  userSelect: "none",
                }}
              >
                {label}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
