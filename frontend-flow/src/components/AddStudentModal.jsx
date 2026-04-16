import { useState } from 'react';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';

const CLASSES = [
  'Form 1A', 'Form 1B', 'Form 1C',
  'Form 2A', 'Form 2B', 'Form 2C',
  'Form 3A', 'Form 3B', 'Form 3C',
  'Form 4A', 'Form 4B', 'Form 4C',
];

const STATUSES = ['Paid', 'Partial', 'Unpaid'];

export default function AddStudentModal({ onClose, onSave }) {
  const [formData, setFormData] = useState({
    name: '', admNo: '', className: 'Form 1A', fee: '', status: 'Unpaid', paid: ''
  });

  const handleSubmit = async (e) => {
    e.preventDefault();

    const fee = Number(formData.fee);
    if (!formData.name || !formData.admNo || !formData.className || Number.isNaN(fee)) return;

    let paid = formData.paid !== '' ? Number(formData.paid) : 0;
    if (Number.isNaN(paid) || paid < 0) paid = 0;
    if (paid > fee) paid = fee;
    if (formData.paid === '') {
      paid = formData.status === 'Paid' ? fee : 0;
    }

    try {
      await onSave({
        name: formData.name,
        admNo: formData.admNo,
        className: formData.className,
        fee,
        paid,
        status: formData.status,
      });

      toast.success('Student added successfully!');
      onClose();
    } catch (error) {
      toast.error('Failed to add student. Please try again.');
      console.error('Failed to add student', error);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal anim-up" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Add New Student</div>
          <button className="btn-icon" onClick={onClose}><X /></button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">Student Full Name</label>
              <input
                required
                type="text"
                className="form-input"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. John Doe"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Admission Number</label>
              <input
                required
                type="text"
                className="form-input"
                value={formData.admNo}
                onChange={e => setFormData({ ...formData, admNo: e.target.value })}
                placeholder="e.g. ADM-1234"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Class</label>
              <select
                className="form-input"
                value={formData.className}
                onChange={e => setFormData({ ...formData, className: e.target.value })}
              >
                {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Total Fee Amount</label>
              <input
                required
                type="number"
                className="form-input"
                value={formData.fee}
                onChange={e => setFormData({ ...formData, fee: e.target.value })}
                placeholder="e.g. 22000"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Status</label>
              <select
                className="form-input"
                value={formData.status}
                onChange={e => setFormData({ ...formData, status: e.target.value })}
              >
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Amount Paid (optional)</label>
              <input
                type="number"
                className="form-input"
                value={formData.paid}
                onChange={e => setFormData({ ...formData, paid: e.target.value })}
                placeholder="Optional, leave blank to infer from status"
              />
            </div>
          </div>

          <div className="modal-head" style={{ justifyContent: 'flex-end', gap: '10px' }}>
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Save Student</button>
          </div>
        </form>
      </div>
    </div>
  );
}