import React from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowRight, Zap, BarChart2, DollarSign } from 'lucide-react';

const WelcomePage = () => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <Card className="w-full max-w-2xl bg-gray-800 border-gray-700 overflow-hidden">
          <CardHeader className="text-center pb-8">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: 'spring', stiffness: 200, damping: 10 }}
            >
              <Zap size={64} className="text-yellow-400 mx-auto mb-4" />
            </motion.div>
            <CardTitle className="text-3xl font-bold text-white mb-2">Welcome to Your Dashboard!</CardTitle>
            <p className="text-gray-400 text-lg">You're all set up and ready to go. Let's start tracking your success!</p>
          </CardHeader>
          <CardContent className="pb-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              <Feature 
                icon={<BarChart2 className="text-blue-500" size={32} />}
                title="Track Your Growth"
                description="Monitor your transaction volume and see your business expand."
              />
              <Feature 
                icon={<DollarSign className="text-green-500" size={32} />}
                title="Analyze Revenue"
                description="Get insights into your earnings and financial performance."
              />
            </div>
            <div className="text-center">
              <Button className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-full transition duration-300 ease-in-out transform hover:scale-105">
                Start Accepting Payments
                <ArrowRight className="ml-2" size={20} />
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
};

const Feature = ({ icon, title, description }) => (
  <motion.div
    className="flex items-start space-x-4"
    initial={{ opacity: 0, x: -20 }}
    animate={{ opacity: 1, x: 0 }}
    transition={{ delay: 0.4, duration: 0.5 }}
  >
    <div className="flex-shrink-0">
      {icon}
    </div>
    <div>
      <h3 className="text-lg font-semibold text-white mb-1">{title}</h3>
      <p className="text-gray-400">{description}</p>
    </div>
  </motion.div>
);

export default WelcomePage;