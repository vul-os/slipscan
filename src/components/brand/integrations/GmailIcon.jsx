// Gmail brand mark — the official 4-color envelope.
// Construction follows Google's published geometry (viewBox 256x193):
// blue left side, green right side, red center back, yellow right back,
// and a darker red sliver on the inside-left that reveals the "M".
export default function GmailIcon({ className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 193"
      preserveAspectRatio="xMidYMid"
      aria-hidden="true"
      role="img"
      className={className}
    >
      <path
        fill="#4285F4"
        d="M58.182 192.05V93.14L27.507 65.077 0 49.504v125.091c0 9.658 7.825 17.455 17.455 17.455z"
      />
      <path
        fill="#34A853"
        d="M197.818 192.05h40.727c9.659 0 17.455-7.826 17.455-17.455V49.504l-31.156 17.838-27.026 25.798z"
      />
      <path
        fill="#EA4335"
        d="M58.182 93.14V18.547L128 70.985l69.818-52.438V93.14L128 145.578z"
      />
      <path
        fill="#FBBC04"
        d="M197.818 18.547V93.14L256 49.504V27.345c0-20.53-23.43-32.247-39.854-19.927z"
      />
      <path
        fill="#C5221F"
        d="M0 49.504 58.182 93.14V18.547L39.854 7.418C23.42-4.901 0 6.816 0 27.345z"
      />
    </svg>
  );
}
