import React, { useEffect, useState } from 'react';
import { supabase } from '../../services/supabaseClient';
import { File, FileText, Image as ImageIcon } from 'lucide-react';

const FilePreview = ({ doc }) => {
  const [previewUrl, setPreviewUrl] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchPreviewUrl = async () => {
      if (doc.document_files && doc.document_files[0] && doc.document_files[0].content_type.startsWith('image/')) {
        setIsLoading(true);
        try {
          const { data, error } = await supabase.storage
            .from('snaps')
            .createSignedUrl(doc.document_files[0].file_path, 3600); // 1 hour expiration

          if (!error) {
            setPreviewUrl(data.signedUrl);
          }
        } catch (error) {
          console.error('Error fetching preview URL:', error);
        } finally {
          setIsLoading(false);
        }
      } else {
        setIsLoading(false);
      }
    };

    fetchPreviewUrl();
  }, [doc]);

  const getFileIcon = () => {
    if (doc.document_files && doc.document_files[0]) {
      const contentType = doc.document_files[0].content_type;
      const iconProps = {
        className: "h-16 w-16 text-blue-600",
        strokeWidth: 1.5
      };

      if (contentType.startsWith('image/')) {
        return <ImageIcon {...iconProps} />;
      } else if (contentType === 'application/pdf') {
        return <FileText {...iconProps} />;
      } else {
        return <File {...iconProps} />;
      }
    } else {
      return <File className="h-12 w-12 text-gray-400" />;
    }
  };

  return (
    <div className="relative w-full h-0 pb-[100%] bg-gray-100 rounded-md overflow-hidden">
      {isLoading ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
        </div>
      ) : previewUrl ? (
        <img 
          src={previewUrl} 
          alt={doc.transaction_number} 
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          {getFileIcon()}
        </div>
      )}
    </div>
  );
};

export default FilePreview;