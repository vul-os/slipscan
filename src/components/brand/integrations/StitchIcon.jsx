/**
 * Stitch brand icon (Stitch Money — SA fintech bank-feed provider).
 * Primary brand colour: #FF5722 (deep orange, consistent with Stitch's visual identity).
 *
 * Stitch's logo mark is a stylised interlocking "S" / thread motif in orange.
 * This is a geometric approximation that reads clearly at small sizes:
 * two overlapping rounded arcs forming a rotational-symmetry "S" shape,
 * similar to the interlocked curves in their actual mark.
 *
 * If the exact logo is needed, replace the paths with official brand assets
 * once Stitch provides them.
 */
export default function StitchIcon({ className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      aria-hidden="true"
      role="img"
      className={className}
    >
      {/*
        Stitch "S" mark:
        Two thick arcs — top-right quarter circle and bottom-left quarter circle —
        connected smoothly in the middle to form a rotational-symmetric S.
        Drawn as a single filled path using bezier curves.

        The shape resembles an elongated S with a slight lean, enclosed in a
        rounded square background.
      */}
      {/* Orange rounded square background */}
      <rect x="0" y="0" width="24" height="24" rx="5.5" fill="#FF5722" />
      {/*
        White S-curve path:
        Top half: arc from left-centre curving up and right to top-centre
        Middle: flows through centre
        Bottom half: arc from right-centre curving down and left to bottom-centre
      */}
      <path
        fill="#ffffff"
        d="
          M 7.5 9.5
          C 7.5 7.0 9.5 5.0 12.0 5.0
          L 16.5 5.0
          C 17.33 5.0 18.0 5.67 18.0 6.5
          C 18.0 7.33 17.33 8.0 16.5 8.0
          L 12.0 8.0
          C 11.17 8.0 10.5 8.67 10.5 9.5
          C 10.5 10.33 11.17 11.0 12.0 11.0
          L 14.5 11.0
          C 17.26 11.0 19.5 13.24 19.5 16.0
          C 19.5 18.76 17.26 21.0 14.5 21.0
          L 7.5 21.0
          C 6.67 21.0 6.0 20.33 6.0 19.5
          C 6.0 18.67 6.67 18.0 7.5 18.0
          L 14.5 18.0
          C 15.6 18.0 16.5 17.1 16.5 16.0
          C 16.5 14.9 15.6 14.0 14.5 14.0
          L 12.0 14.0
          C 9.5 14.0 7.5 12.0 7.5 9.5
          Z
        "
      />
    </svg>
  );
}
