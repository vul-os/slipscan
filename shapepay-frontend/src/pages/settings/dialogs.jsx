import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const InviteUserDialog = ({ open, onOpenChange, onInvite, loading }) => {
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('');

  const handleInvite = () => {
    onInvite(inviteEmail, inviteRole);
    setInviteEmail('');
    setInviteRole('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-gray-800 text-gray-100 border-gray-700">
        <DialogHeader>
          <DialogTitle>Invite User</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="Email"
            className="bg-gray-700 text-gray-100 border-gray-600"
          />
          <Select value={inviteRole} onValueChange={setInviteRole}>
            <SelectTrigger className="bg-gray-700 text-gray-300 border-gray-600">
              <SelectValue placeholder="Select role" />
            </SelectTrigger>
            <SelectContent className="bg-gray-700 text-gray-300 border-gray-600">
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="viewer">Viewer</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={handleInvite} disabled={loading} className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700">
            {loading ? 'Sending...' : 'Send Invitation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const EditUserDialog = ({ open, onOpenChange, currentUser, onEdit, loading }) => {
  const [editedUser, setEditedUser] = useState(currentUser || {});

  const handleEdit = () => {
    onEdit(editedUser);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-gray-800 text-gray-100 border-gray-700">
        <DialogHeader>
          <DialogTitle>Edit User</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            value={editedUser.email || ''}
            disabled
            className="bg-gray-700 text-gray-400 border-gray-600"
          />
          <Select
            value={editedUser.role_name || ''}
            onValueChange={(value) => setEditedUser(prev => ({ ...prev, role_name: value }))}
          >
            <SelectTrigger className="bg-gray-700 text-gray-300 border-gray-600">
              <SelectValue placeholder="Select role" />
            </SelectTrigger>
            <SelectContent className="bg-gray-700 text-gray-300 border-gray-600">
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="viewer">Viewer</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={handleEdit} disabled={loading} className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700">
            {loading ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const DeleteUserDialog = ({ open, onOpenChange, onDelete, loading }) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-gray-800 text-gray-100 border-gray-700">
        <DialogHeader>
          <DialogTitle>Confirm User Removal</DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-gray-300">
          Are you sure you want to remove this user? This action cannot be undone.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="bg-gray-700 text-gray-300 hover:bg-gray-600">
            Cancel
          </Button>
          <Button onClick={onDelete} disabled={loading} className="bg-red-600 hover:bg-red-700">
            {loading ? 'Removing...' : 'Remove User'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const DeleteInvitationDialog = ({ open, onOpenChange, onDelete, loading }) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-gray-800 text-gray-100 border-gray-700">
        <DialogHeader>
          <DialogTitle>Confirm Invitation Removal</DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-gray-300">
          Are you sure you want to remove this invitation? This action cannot be undone.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="bg-gray-700 text-gray-300 hover:bg-gray-600">
            Cancel
          </Button>
          <Button onClick={onDelete} disabled={loading} className="bg-red-600 hover:bg-red-700">
            {loading ? 'Removing...' : 'Remove Invitation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};