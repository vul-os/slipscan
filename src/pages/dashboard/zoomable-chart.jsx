import React from 'react';
import { ResponsiveContainer } from 'recharts';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';

const ZoomableChart = ({ children, isMobile }) => {
  if (!isMobile) {
    return <ResponsiveContainer width="100%" height={300}>{children}</ResponsiveContainer>;
  }

  return (
    <TransformWrapper
      initialScale={1}
      minScale={0.5}
      maxScale={3}
      wheel={{ step: 0.1 }}
    >
      <TransformComponent>
        <div style={{ width: '100%', height: '300px', overflow: 'hidden' }}>
          {children}
        </div>
      </TransformComponent>
    </TransformWrapper>
  );
};

export default ZoomableChart;