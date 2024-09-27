import React, { useEffect, useState, useContext } from 'react';
import { supabase } from '../services/supabaseClient';
import { AuthContext } from '../context/use-auth';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Folder, ChevronRight, Upload } from 'lucide-react';
import { toast } from "@/components/ui/use-toast";

const Categories = () => {
  const [categories, setCategories] = useState([]);
  const { user } = useContext(AuthContext);

  useEffect(() => {
    if (user) {
      fetchCategories();
    }
  }, [user]);

  const fetchCategories = async () => {
    const { data, error } = await supabase
      .from('categories')
      .select(`
        id,
        name,
        description,
        subcategories (
          id,
          name,
          description
        )
      `)
      .eq('user_id', user.id)
      .order('name');

    if (error) {
      console.error('Error fetching categories:', error);
      toast({
        title: "Error",
        description: "Failed to fetch categories. Please try again.",
        variant: "destructive",
      });
    } else {
      setCategories(data);
    }
  };

  const EmptyState = () => (
    <div className="text-center py-10">
      <Upload className="mx-auto h-12 w-12 text-gray-400" />
      <h3 className="mt-2 text-sm font-semibold text-gray-900">No categories yet</h3>
      <p className="mt-1 text-sm text-gray-500">Get started by uploading your first slip!</p>
      <div className="mt-6">
        <button
          type="button"
          className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          <Upload className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
          Upload a slip
        </button>
      </div>
    </div>
  );

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Categories</CardTitle>
      </CardHeader>
      <CardContent>
        {categories.length === 0 ? (
          <EmptyState />
        ) : (
          <Accordion type="single" collapsible className="w-full">
            {categories.map((category) => (
              <AccordionItem value={category.id} key={category.id}>
                <AccordionTrigger>
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center">
                      <Folder className="mr-2 h-4 w-4" />
                      <span>{category.name}</span>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="pl-6 space-y-2">
                    {category.subcategories.map((subcategory) => (
                      <div key={subcategory.id} className="flex items-center text-sm">
                        <ChevronRight className="mr-2 h-3 w-3" />
                        <span>{subcategory.name}</span>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
};

export default Categories;