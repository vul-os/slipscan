import React from 'react';
import { File, FileText, Image as ImageIcon } from 'lucide-react';

const FilePreview = ({ file, signedUrl }) => {
  const getFileIcon = () => {
    const contentType = file.content_type;
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
  };

  return (
    <div className="relative w-full h-0 pb-[100%] bg-gray-100 rounded-md overflow-hidden">
      {signedUrl && file.content_type.startsWith('image/') ? (
        <img 
          src={signedUrl} 
          alt={file.file_name} 
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