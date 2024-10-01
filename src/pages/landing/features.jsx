import React from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Camera, Zap, PieChart } from 'lucide-react';

const Features = React.forwardRef((props, ref) => {
  return (
    <section ref={ref} className="mb-16 sm:mb-24">
      <h2 className="text-3xl sm:text-4xl font-bold text-center mb-8 sm:mb-12 text-gray-800">How SlipSnap Works</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-12">
        <Card className="bg-white shadow-lg hover:shadow-xl transition-shadow">
          <CardContent className="pt-8 flex flex-col items-center">
            <Camera size={48} className="text-blue-600 mb-6" />
            <h3 className="text-xl sm:text-2xl font-semibold mb-4 text-gray-800">Snap Your Receipts</h3>
            <p className="text-gray-600 text-center">Simply take a photo of your receipt or slip, and our AI will do the rest.</p>
          </CardContent>
        </Card>
        <Card className="bg-white shadow-lg hover:shadow-xl transition-shadow">
          <CardContent className="pt-8 flex flex-col items-center">
            <Zap size={48} className="text-blue-600 mb-6" />
            <h3 className="text-xl sm:text-2xl font-semibold mb-4 text-gray-800">Instant Analysis</h3>
            <p className="text-gray-600 text-center">Our AI quickly extracts and categorizes your spending data.</p>
          </CardContent>
        </Card>
        <Card className="bg-white shadow-lg hover:shadow-xl transition-shadow">
          <CardContent className="pt-8 flex flex-col items-center">
            <PieChart size={48} className="text-blue-600 mb-6" />
            <h3 className="text-xl sm:text-2xl font-semibold mb-4 text-gray-800">Smart Insights</h3>
            <p className="text-gray-600 text-center">Get personalized spending breakdowns and money-saving tips.</p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
});

export default Features;