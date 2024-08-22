import React, { useState, useEffect, useContext } from 'react';
import { supabase } from '../services/supabaseClient';
import { AuthContext } from '../context/use-auth';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PlusCircle, Edit2, Trash2, Home } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from "@/components/ui/use-toast";

const SettingsPage = () => {
  const { user, activeMerchantId } = useContext(AuthContext);
  const [merchant, setMerchant] = useState({
    id: '',
    name: '',
    email: '',
    phone: ''
  });
  const [users, setUsers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isEditingName, setIsEditingName] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('');
  const [editUserDialogOpen, setEditUserDialogOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [error, setError] = useState(null);
  const { toast } = useToast();

  // New state for confirmation dialogs
  const [deleteUserDialogOpen, setDeleteUserDialogOpen] = useState(false);
  const [deleteInvitationDialogOpen, setDeleteInvitationDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState(null);
  const [invitationToDelete, setInvitationToDelete] = useState(null);

  useEffect(() => {
    if (user) {
      fetchMerchantUsersAndInvitations();
    }
  }, [user]);

  const fetchMerchantUsersAndInvitations = async () => {
    try {
      setLoading(true);

      // Fetch merchant details
      const { data: md, error: me } = await supabase
        .from('merchants')
        .select('*')
        .eq('id', activeMerchantId)
        .single();

      if (me) throw me;
      setMerchant(md);

      // Fetch users
      const { data: userMerchantData, error: userMerchantError } = await supabase
        .from('merchant_users')
        .select(`
          user_id,
          profiles:user_id (email),
          roles:role_id (name)
        `)
        .eq('merchant_id', activeMerchantId);
  
      if (userMerchantError) throw userMerchantError;
  
      if (userMerchantData.length > 0) {
        const usersWithRoles = userMerchantData.map(user => ({
          user_id: user?.user_id,
          email: user.profiles ? user.profiles?.email : 'No Email',
          role_name: user.roles ? user.roles?.name : 'Unknown Role',
        }));
  
        setUsers(usersWithRoles);
      }

      // Fetch invitations
      const { data: invitationsData, error: invitationsError } = await supabase
        .from('merchant_invitations')
        .select('email, role_name')
        .eq('merchant_id', activeMerchantId);

      if (invitationsError) throw invitationsError;

      setInvitations(invitationsData);

    } catch (error) {
      console.error('Error fetching data:', error);
      setError('Failed to fetch information');
      toast({
        title: "Error",
        description: "Failed to fetch information",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };  

  const handleMerchantNameClick = () => {
    setIsEditingName(true);
  };

  const handleMerchantNameChange = (e) => {
    setMerchant(prev => ({ ...prev, name: e.target.value }));
  };

  const handleMerchantNameSubmit = async (e) => {
    if (e.key === 'Enter') {
      try {
        setLoading(true);
        const { error } = await supabase
          .from('merchants')
          .update({ name: merchant.name })
          .eq('id', merchant.id);

        if (error) throw error;

        setIsEditingName(false);
        toast({
          title: "Success",
          description: "Merchant name updated successfully!",
          duration: 3000,
        });
      } catch (error) {
        console.error('Error updating merchant name:', error);
        toast({
          title: "Error",
          description: "Error updating merchant name",
          variant: "destructive",
          duration: 5000,
        });
      } finally {
        setLoading(false);
      }
    }
  };

  const handleInviteUser = async () => {
    try {
      setLoading(true);
      const { error } = await supabase.functions.invoke('invite-merchant', {
        body: { inviteeEmail: inviteEmail, merchantId: merchant.id, roleName: inviteRole }
      });

      if (error) throw error;
      toast({
        title: "Success",
        description: "Invitation sent successfully!",
        duration: 3000,
      });
      setInviteDialogOpen(false);
      setInviteEmail('');
      setInviteRole('');
      fetchMerchantUsersAndInvitations();
    } catch (error) {
      console.error('Error inviting user:', error);
      toast({
        title: "Error",
        description: "Error sending invitation",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleChangeRole = async (userId, newRole) => {
    try {
      setLoading(true);
      const { data: roleData } = await supabase
        .from('roles')
        .select('id')
        .eq('name', newRole)
        .single();

      const { error } = await supabase
        .from('merchant_users')
        .update({ role_id: roleData.id })
        .eq('user_id', userId)
        .eq('merchant_id', merchant.id);

      if (error) throw error;
      toast({
        title: "Success",
        description: "User role updated successfully!",
        duration: 3000,
      });
      fetchMerchantUsersAndInvitations();
    } catch (error) {
      console.error('Error updating user role:', error);
      toast({
        title: "Error",
        description: "Error updating user role",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = (userId) => {
    setUserToDelete(userId);
    setDeleteUserDialogOpen(true);
  };

  const confirmDeleteUser = async () => {
    try {
      setLoading(true);
      const { error } = await supabase
        .from('merchant_users')
        .delete()
        .eq('user_id', userToDelete)
        .eq('merchant_id', merchant.id);

      if (error) throw error;
      toast({
        title: "Success",
        description: "User removed successfully!",
        duration: 3000,
      });
      fetchMerchantUsersAndInvitations();
    } catch (error) {
      console.error('Error removing user:', error);
      toast({
        title: "Error",
        description: "Error removing user",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
      setDeleteUserDialogOpen(false);
      setUserToDelete(null);
    }
  };

  const handleRemoveInvitation = (email) => {
    setInvitationToDelete(email);
    setDeleteInvitationDialogOpen(true);
  };

  const confirmRemoveInvitation = async () => {
    try {
      setLoading(true);
      const { error } = await supabase
        .from('merchant_invitations')
        .delete()
        .eq('email', invitationToDelete)
        .eq('merchant_id', merchant.id);

      if (error) throw error;
      toast({
        title: "Success",
        description: "Invitation removed successfully!",
        duration: 3000,
      });
      fetchMerchantUsersAndInvitations();
    } catch (error) {
      console.error('Error removing invitation:', error);
      toast({
        title: "Error",
        description: "Error removing invitation",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
      setDeleteInvitationDialogOpen(false);
      setInvitationToDelete(null);
    }
  };

  const handleEditUser = (user) => {
    setCurrentUser(user);
    setEditUserDialogOpen(true);
  };

  const handleEditUserSubmit = async () => {
    try {
      setLoading(true);
      const { error } = await supabase
        .from('merchant_users')
        .update({
          role_id: currentUser.role_id,
        })
        .eq('user_id', currentUser.user_id)
        .eq('merchant_id', merchant.id);

      if (error) throw error;

      toast({
        title: "Success",
        description: "User updated successfully!",
        duration: 3000,
      });
      setEditUserDialogOpen(false);
      fetchMerchantUsersAndInvitations();
    } catch (error) {
      console.error('Error updating user:', error);
      toast({
        title: "Error",
        description: "Error updating user",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="text-center text-gray-300">Loading...</div>;
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <div className="container mx-auto px-2 sm:px-4 py-4">
        <div className="flex items-center space-x-2 mb-4">
          <Link to="/" className="text-blue-400 hover:text-blue-300 flex items-center">
            <Home className="w-4 h-4 mr-1" />
            Home
          </Link>
          <span>/</span>
          <span className="flex items-center">
            Settings
          </span>
        </div>

        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-100">Merchant Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-col sm:flex-row items-center justify-between space-y-4 sm:space-y-0 sm:space-x-4">
              <div className="flex flex-col sm:flex-row items-center space-y-2 sm:space-y-0 sm:space-x-4">
                <Avatar className="w-16 h-16 border-2 border-gray-600">
                  <AvatarImage src="/path-to-avatar-image.png" alt={merchant.name} />
                  <AvatarFallback className="bg-gray-700 text-gray-300">{merchant.name[0]}</AvatarFallback>
                </Avatar>
                {isEditingName ? (
                  <Input
                    value={merchant.name}
                    onChange={handleMerchantNameChange}
                    onKeyDown={handleMerchantNameSubmit}
                    className="text-xl sm:text-2xl font-bold bg-gray-700 text-gray-100 border-gray-600"
                  />
                ) : (
                  <h2 onClick={handleMerchantNameClick} className="text-xl sm:text-2xl font-bold cursor-pointer text-gray-100">
                    {merchant.name}
                  </h2>
                )}
              </div>
              <Button onClick={() => setInviteDialogOpen(true)} className="w-full sm:w-auto flex items-center justify-center bg-blue-600 hover:bg-blue-700">
                <PlusCircle className="mr-2 h-4 w-4" />
                Invite User
              </Button>
            </div>

            <Card className="bg-gray-800 border-gray-700 shadow-lg">
              <CardHeader>
                <CardTitle className="text-gray-100">User Management</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b border-gray-700">
                      <TableHead className="text-gray-300">Email</TableHead>
                      <TableHead className="text-gray-300">Role</TableHead>
                      <TableHead className="text-right text-gray-300">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                  {users.map((user) => (
                      <TableRow key={user.user_id} className="border-b border-gray-700">
                        <TableCell className="text-gray-300">{user?.email}</TableCell>
                        <TableCell>
                          <Select
                            value={user.role_name}
                            onValueChange={(value) => handleChangeRole(user.user_id, value)}
                          >
                            <SelectTrigger className="w-[120px] sm:w-[180px] bg-gray-700 text-gray-300 border-gray-600">
                              <SelectValue placeholder="Select role" />
                            </SelectTrigger>
                            <SelectContent className="bg-gray-700 text-gray-300 border-gray-600">
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="viewer">Viewer</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => handleEditUser(user)} className="text-gray-300 hover:text-gray-100 p-1 sm:p-2">
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleDeleteUser(user.user_id)} className="text-gray-300 hover:text-gray-100 p-1 sm:p-2">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card className="bg-gray-800 border-gray-700 shadow-lg mt-6">
              <CardHeader>
                <CardTitle className="text-gray-100">Pending Invitations</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b border-gray-700">
                      <TableHead className="text-gray-300">Email</TableHead>
                      <TableHead className="text-gray-300">Role</TableHead>
                      <TableHead className="text-right text-gray-300">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invitations.map((invitation, index) => (
                      <TableRow key={index} className="border-b border-gray-700">
                        <TableCell className="text-gray-300">{invitation.email}</TableCell>
                        <TableCell className="text-gray-300">{invitation.role_name}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveInvitation(invitation.email)}
                            className="text-gray-300 hover:text-gray-100 p-1 sm:p-2"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </CardContent>
        </Card>
      </div>

      {/* Invite User Dialog */}
      <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
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
            <Button onClick={handleInviteUser} disabled={loading} className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700">
              {loading ? 'Sending...' : 'Send Invitation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={editUserDialogOpen} onOpenChange={setEditUserDialogOpen}>
        <DialogContent className="bg-gray-800 text-gray-100 border-gray-700">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              value={currentUser?.email || ''}
              disabled
              className="bg-gray-700 text-gray-400 border-gray-600"
            />
            <Select
              value={currentUser?.role_name || ''}
              onValueChange={(value) => setCurrentUser(prev => ({ ...prev, role_name: value }))}
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
            <Button onClick={handleEditUserSubmit} disabled={loading} className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700">
              {loading ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete User Confirmation Dialog */}
      <Dialog open={deleteUserDialogOpen} onOpenChange={setDeleteUserDialogOpen}>
        <DialogContent className="bg-gray-800 text-gray-100 border-gray-700">
          <DialogHeader>
            <DialogTitle>Confirm User Removal</DialogTitle>
          </DialogHeader>
          <DialogDescription className="text-gray-300">
            Are you sure you want to remove this user? This action cannot be undone.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteUserDialogOpen(false)} className="bg-gray-700 text-gray-300 hover:bg-gray-600">
              Cancel
            </Button>
            <Button onClick={confirmDeleteUser} disabled={loading} className="bg-red-600 hover:bg-red-700">
              {loading ? 'Removing...' : 'Remove User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Invitation Confirmation Dialog */}
      <Dialog open={deleteInvitationDialogOpen} onOpenChange={setDeleteInvitationDialogOpen}>
        <DialogContent className="bg-gray-800 text-gray-100 border-gray-700">
          <DialogHeader>
            <DialogTitle>Confirm Invitation Removal</DialogTitle>
          </DialogHeader>
          <DialogDescription className="text-gray-300">
            Are you sure you want to remove this invitation? This action cannot be undone.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteInvitationDialogOpen(false)} className="bg-gray-700 text-gray-300 hover:bg-gray-600">
              Cancel
            </Button>
            <Button onClick={confirmRemoveInvitation} disabled={loading} className="bg-red-600 hover:bg-red-700">
              {loading ? 'Removing...' : 'Remove Invitation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SettingsPage;