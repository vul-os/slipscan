import React from 'react';
import { DataGrid } from '@mui/x-data-grid';

const DataTable = ({ columns, rows, pageSize }) => {
  return (
    <div style={{ height: 600, width: '100%' }}>
      <DataGrid
        rows={rows}
        columns={columns}
        pageSize={pageSize}
        rowsPerPageOptions={[5, 10, 20]}
        checkboxSelection
        disableSelectionOnClick
      />
    </div>
  );
};

export default DataTable;
