import React, { useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PlusCircle } from 'lucide-react';

const MerchantHeader = ({ merchant, onUpdateName, onInviteUser }) => {
  const [isEditingName, setIsEditingName] = useState(false);
  const [tempName, setTempName] = useState(merchant.name);

  const handleNameChange = (e) => {
    setTempName(e.target.value);
  };

  const handleNameSubmit = async (e) => {
    if (e.key === 'Enter') {
      await onUpdateName(tempName);
      setIsEditingName(false);
    }
  };

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between space-y-4 sm:space-y-0 sm:space-x-4">
      <div className="flex flex-col sm:flex-row items-center space-y-2 sm:space-y-0 sm:space-x-4">
        <Avatar className="w-16 h-16 border-2 border-gray-600">
          <AvatarImage src="/path-to-avatar-image.png" alt={merchant.name} />
          <AvatarFallback className="bg-gray-700 text-gray-300">{merchant.name[0]}</AvatarFallback>
        </Avatar>
        {isEditingName ? (
          <Input
            value={tempName}
            onChange={handleNameChange}
            onKeyDown={handleNameSubmit}
            className="text-xl sm:text-2xl font-bold bg-gray-700 text-gray-100 border-gray-600"
          />
        ) : (
          <h2 onClick={() => setIsEditingName(true)} className="text-xl sm:text-2xl font-bold cursor-pointer text-gray-100">
            {merchant.name}
          </h2>
        )}
      </div>
      <Button onClick={onInviteUser} className="w-full sm:w-auto flex items-center justify-center bg-blue-600 hover:bg-blue-700">
        <PlusCircle className="mr-2 h-4 w-4" />
        Invite User
      </Button>
    </div>
  );
};

export default MerchantHeader;