import React, { useEffect, useState, useContext } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../services/supabaseClient';
import { AuthContext } from '../context/use-auth';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Folder, Save } from 'lucide-react';
import { toast } from "@/components/ui/use-toast";

const Items = () => {
  const [documentGroups, setDocumentGroups] = useState([]);
  const [sortBy, setSortBy] = useState('date');
  const [sortOrder, setSortOrder] = useState('desc');
  const [editingItem, setEditingItem] = useState(null);
  const { user } = useContext(AuthContext);
  const { groupId } = useParams();

  useEffect(() => {
    if (user) {
      fetchDocumentGroups();
    }
  }, [user, sortBy, sortOrder, groupId]);

  const fetchDocumentGroups = async () => {
    let query = supabase
      .from('document_groups')
      .select(`
        id,
        name,
        created_at,
        extracted_items (
          id,
          description,
          quantity,
          price,
          tax_amount,
          user_modified_extracted_items (
            id,
            description,
            quantity,
            price,
            tax_amount
          )
        )
      `)
      .eq('user_id', user.id)
      .order(sortBy === 'name' ? 'name' : 'created_at', { ascending: sortOrder === 'asc' });

    if (groupId) {
      query = query.eq('id', groupId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching document groups:', error);
      toast({
        title: "Error",
        description: "Failed to fetch items. Please try again.",
        variant: "destructive",
      });
    } else {
      const processedData = data.map(group => ({
        ...group,
        items: group.extracted_items.map(item => ({
          ...item,
          ...item.user_modified_extracted_items[0],
          isModified: item.user_modified_extracted_items.length > 0
        }))
      }));
      setDocumentGroups(processedData);
    }
  };

  const handleEdit = (item) => {
    setEditingItem(item);
  };

  const handleSave = async () => {
    if (!editingItem) return;

    const { data, error } = await supabase
      .from('user_modified_extracted_items')
      .upsert({
        user_id: user.id,
        document_group_id: editingItem.document_group_id,
        original_extracted_item_id: editingItem.id,
        description: editingItem.description,
        quantity: editingItem.quantity,
        price: editingItem.price,
        tax_amount: editingItem.tax_amount
      });

    if (error) {
      console.error('Error saving item:', error);
      toast({
        title: "Error",
        description: "Failed to save item. Please try again.",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Success",
        description: "Item saved successfully.",
      });
      setEditingItem(null);
      fetchDocumentGroups();
    }
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex flex-col sm:flex-row justify-between items-start sm:items-center space-y-2 sm:space-y-0">
          <span>Items</span>
          <div className="flex space-x-2">
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="date">Date</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortOrder} onValueChange={setSortOrder}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Sort order" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Accordion type="single" collapsible className="w-full">
          {documentGroups.map((group) => (
            <AccordionItem value={group.id} key={group.id}>
              <AccordionTrigger>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center">
                    <Folder className="mr-2 h-4 w-4" />
                    <span>{group.name || `Group ${group.id}`}</span>
                  </div>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Description</TableHead>
                      <TableHead>Quantity</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Tax Amount</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          {editingItem?.id === item.id ? (
                            <Input
                              value={editingItem.description}
                              onChange={(e) => setEditingItem({...editingItem, description: e.target.value})}
                            />
                          ) : (
                            item.description
                          )}
                        </TableCell>
                        <TableCell>
                          {editingItem?.id === item.id ? (
                            <Input
                              type="number"
                              value={editingItem.quantity}
                              onChange={(e) => setEditingItem({...editingItem, quantity: e.target.value})}
                            />
                          ) : (
                            item.quantity
                          )}
                        </TableCell>
                        <TableCell>
                          {editingItem?.id === item.id ? (
                            <Input
                              type="number"
                              value={editingItem.price}
                              onChange={(e) => setEditingItem({...editingItem, price: e.target.value})}
                            />
                          ) : (
                            item.price
                          )}
                        </TableCell>
                        <TableCell>
                          {editingItem?.id === item.id ? (
                            <Input
                              type="number"
                              value={editingItem.tax_amount}
                              onChange={(e) => setEditingItem({...editingItem, tax_amount: e.target.value})}
                            />
                          ) : (
                            item.tax_amount
                          )}
                        </TableCell>
                        <TableCell>
                          {editingItem?.id === item.id ? (
                            <Button onClick={handleSave}><Save className="h-4 w-4" /></Button>
                          ) : (
                            <Button onClick={() => handleEdit(item)}>Edit</Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </CardContent>
    </Card>
  );
};

export default Items;