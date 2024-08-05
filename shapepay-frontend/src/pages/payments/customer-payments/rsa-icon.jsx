// SouthAfricanFlag.jsx
import React from 'react';

const SouthAfricanFlag = ({ width = 24, height = 16, className = '' }) => (
  <svg 
    xmlns="http://www.w3.org/2000/svg" 
    width={width} 
    height={height} 
    viewBox="0 0 90 60" 
    className={className}
  >
    <title>Flag of South Africa</title>
    <defs>
      <clipPath id="t">
        <path d="m0 0 45 30L0 60z"/>
      </clipPath>
      <clipPath id="f">
        <path d="m0 0h90v60H0z"/>
      </clipPath>
    </defs>
    <path fill="#e03c31" d="m0 0h90v30H45z"/>
    <path fill="#001489" d="m0 60h90V30H45z"/>
    <g clipPath="url(#f)" fill="none">
      <path stroke="#fff" strokeWidth="20" d="m90 30H45L0 0v60l45-30"/>
      <path fill="#000" stroke="#ffb81c" strokeWidth="20" clipPath="url(#t)" d="m0 0 45 30L0 60"/>
      <path stroke="#007749" strokeWidth="12" d="m0 0 45 30h45M0 60l45-30"/>
    </g>
  </svg>
);

export default SouthAfricanFlag;