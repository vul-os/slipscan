import React, { useState, useEffect, useContext } from 'react';
import { supabase } from '../services/supabaseClient';
import AuthContext from '../context/auth-context';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PlusCircle, Edit2, Trash2, Home } from 'lucide-react';
import { Link } from 'react-router-dom';

const SettingsPage = () => {
  const { user } = useContext(AuthContext);
  const [merchant, setMerchant] = useState({
    id: '',
    name: '',
    email: '',
    phone: ''
  });
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isEditingName, setIsEditingName] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('');
  const [editUserDialogOpen, setEditUserDialogOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (user) {
      fetchMerchantAndUsers();
    }
  }, [user]);

  const fetchMerchantAndUsers = async () => {
    try {
      setLoading(true);
  
      // Step 1: Fetch all merchants associated with the current user
      const { data: merchantUsersData, error: merchantUsersError } = await supabase
        .from('merchant_users')
        .select('merchant_id')
        .eq('user_id', user.id);
  
      if (merchantUsersError) throw merchantUsersError;
      let firstMerchantId;

      // Step 2: Select the first merchant ID (if any) and ensure it's valid
      if (merchantUsersData.length > 0) {
        firstMerchantId = merchantUsersData[0].merchant_id;
        // Check if the fetched merchant_id is valid and not empty
        if (!firstMerchantId || firstMerchantId === '') {
          throw new Error('Invalid Merchant ID');
        }
      } else {
        throw new Error('No merchants found for this user');
      }

      // Step 3: Fetch the merchant details using the firstMerchantId
      const { data: md, error: me } = await supabase
        .from('merchants')
        .select('*')
        .eq('id', firstMerchantId)
        .single();

      if (me) throw me;
      setMerchant(md);

      // Step 4: Fetch the merchant details and user profiles along with roles
      const { data: userMerchantData, error: userMerchantError } = await supabase
        .from('merchant_users')
        .select(`
          user_id,
          profiles:user_id (email),
          roles:role_id (name)
        `)
        .eq('merchant_id', firstMerchantId);
  
      if (userMerchantError) throw userMerchantError;
  
      // Step 5: Process the data
      if (userMerchantData.length > 0) {
        const usersWithRoles = userMerchantData.map(user => ({
          user_id: user?.user_id,
          email: user.profiles ? user.profiles?.email : 'No Email',
          role_name: user.roles ? user.roles?.name : 'Unknown Role',
        }));
  
        setUsers(usersWithRoles);
      } else {
        setError('No users found for this merchant');
      }
    } catch (error) {
      console.error('Error fetching users and roles:', error);
      setError('Failed to fetch user information');
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
        alert('Merchant name updated successfully!');
      } catch (error) {
        console.error('Error updating merchant name:', error);
        alert('Error updating merchant name');
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
      alert('Invitation sent successfully!');
      setInviteDialogOpen(false);
      setInviteEmail('');
      setInviteRole('');
      fetchMerchantAndUsers();
    } catch (error) {
      console.error('Error inviting user:', error);
      alert('Error sending invitation');
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
      alert('User role updated successfully!');
      fetchMerchantAndUsers();
    } catch (error) {
      console.error('Error updating user role:', error);
      alert('Error updating user role');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async (userId) => {
    if (window.confirm('Are you sure you want to remove this user?')) {
      try {
        setLoading(true);
        const { error } = await supabase
          .from('merchant_users')
          .delete()
          .eq('user_id', userId)
          .eq('merchant_id', merchant.id);

        if (error) throw error;
        alert('User removed successfully!');
        fetchMerchantAndUsers();
      } catch (error) {
        console.error('Error removing user:', error);
        alert('Error removing user');
      } finally {
        setLoading(false);
      }
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

      alert('User updated successfully!');
      setEditUserDialogOpen(false);
      fetchMerchantAndUsers();
    } catch (error) {
      console.error('Error updating user:', error);
      alert('Error updating user');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="text-center text-gray-300">Loading...</div>;
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <div className="container mx-auto p-4">
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
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <Avatar className="w-16 h-16 border-2 border-gray-600">
                  <AvatarImage src="/path-to-avatar-image.png" alt={merchant.name} />
                  <AvatarFallback className="bg-gray-700 text-gray-300">{merchant.name[0]}</AvatarFallback>
                </Avatar>
                {isEditingName ? (
                  <Input
                    value={merchant.name}
                    onChange={handleMerchantNameChange}
                    onKeyDown={handleMerchantNameSubmit}
                    className="text-2xl font-bold bg-gray-700 text-gray-100 border-gray-600"
                  />
                ) : (
                  <h2 onClick={handleMerchantNameClick} className="text-2xl font-bold cursor-pointer text-gray-100">
                    {merchant.name}
                  </h2>
                )}
              </div>
              <Button onClick={() => setInviteDialogOpen(true)} className="flex items-center bg-blue-600 hover:bg-blue-700">
                <PlusCircle className="mr-2 h-4 w-4" />
                Invite User
              </Button>
            </div>

            <Card className="bg-gray-800 border-gray-700 shadow-lg">
              <CardHeader>
                <CardTitle className="text-gray-100">User Management</CardTitle>
              </CardHeader>
              <CardContent>
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
                            <SelectTrigger className="w-[180px] bg-gray-700 text-gray-300 border-gray-600">
                              <SelectValue placeholder="Select role" />
                            </SelectTrigger>
                            <SelectContent className="bg-gray-700 text-gray-300 border-gray-600">
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="viewer">Viewer</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => handleEditUser(user)} className="text-gray-300 hover:text-gray-100">
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleDeleteUser(user.user_id)} className="text-gray-300 hover:text-gray-100">
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
            <Button onClick={handleInviteUser} disabled={loading} className="bg-blue-600 hover:bg-blue-700">
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
            <Button onClick={handleEditUserSubmit} disabled={loading} className="bg-blue-600 hover:bg-blue-700">
              {loading ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SettingsPage;