import React from 'react';
import { Card, CardContent } from "@/components/ui/card";

const StatCard = ({ title, value, icon: Icon, trend, trendValue }) => {
  const getTrendColor = () => {
    if (!trend) return 'text-gray-500';
    return trend === 'up' ? 'text-green-500' : 'text-red-500';
  };

  const getTrendIcon = () => {
    if (!trend) return null;
    return trend === 'up' ? '▲' : '▼';
  };

  return (
    <Card className="bg-gray-800 border-gray-700">
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-400 mb-1">{title}</p>
            <h3 className="text-2xl font-bold text-white">{value}</h3>
          </div>
          {Icon && <Icon className="w-8 h-8 text-gray-500" />}
        </div>
        {trend && (
          <div className={`mt-4 flex items-center ${getTrendColor()}`}>
            <span className="text-sm font-medium">{getTrendIcon()} {trendValue}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default StatCard;