import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

const RADIAN = Math.PI / 180;
const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent, index, name }) => {
  const radius = innerRadius + (outerRadius - innerRadius) * 0.7;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);

  return (
    <text 
      x={x} 
      y={y} 
      fill="white" 
      textAnchor={x > cx ? 'start' : 'end'} 
      dominantBaseline="central"
      fontSize="12"
    >
      {`${name} ${(percent * 100).toFixed(0)}%`}
    </text>
  );
};

const CustomPieChart = ({ data, generateBlueShades }) => {
  const colors = generateBlueShades(data.length);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          labelLine={false}
          label={renderCustomizedLabel}
          outerRadius="90%"
          innerRadius="30%"
          paddingAngle={2}
          fill="#8884d8"
          dataKey="amount"
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
          ))}
        </Pie>
        <Tooltip 
          formatter={(value, name) => [`${value.toFixed(2)} ZAR`, name]}
          contentStyle={{ backgroundColor: '#1f2937', border: 'none' }}
          itemStyle={{ color: '#fff' }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
};

export default CustomPieChart;