/**
 * Google Drive brand icon — three-coloured triangle "drive" mark.
 * Brand colours:
 *   #4285F4  — Google Blue  (left/bottom-left arm)
 *   #34A853  — Google Green (right/bottom-right arm)
 *   #FBBC05  — Google Yellow (top arm)
 *
 * The Drive mark is three parallelogram arms arranged in a triangle.
 * Paths reproduced from the simple-icons Google Drive SVG (MIT licence),
 * split into three segments and individually coloured.
 */
export default function GoogleDriveIcon({ className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      aria-hidden="true"
      role="img"
      className={className}
    >
      {/* Yellow — top arm: the upward-pointing segment */}
      <path
        fill="#FBBC05"
        d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62z"
      />
      {/* Blue — left arm: the left-pointing segment */}
      <path
        fill="#4285F4"
        d="M7.25 3.215a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.215z"
      />
      {/* Green — bottom arm: the bottom connecting segment */}
      <path
        fill="#34A853"
        d="M9.509 15.868l-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z"
      />
    </svg>
  );
}
