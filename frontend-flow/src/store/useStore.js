import { create } from 'zustand';

const INITIAL_STUDENTS = [
  { id: 1, adm:"ADM-0721", name:"Amina Wanjiru",    cls:"Form 3A", form:3, fee:22000, paid:22000, status:"Paid",    phone:"0712345678", parent:"Joyce Wanjiru"  },
  { id: 2, adm:"ADM-1154", name:"Brian Otieno",     cls:"Form 1B", form:1, fee:18000, paid:8000,  status:"Partial", phone:"0723456789", parent:"Thomas Otieno"  },
  { id: 3, adm:"ADM-0834", name:"Christine Muthoni",cls:"Form 2C", form:2, fee:20000, paid:20000, status:"Paid",    phone:"0734567890", parent:"Grace Muthoni"  },
  { id: 4, adm:"ADM-1042", name:"David Kipchoge",   cls:"Form 4A", form:4, fee:24000, paid:5500,  status:"Unpaid",  phone:"0745678901", parent:"Paul Kipchoge"  },
  { id: 5, adm:"ADM-0903", name:"Esther Njeri",     cls:"Form 2A", form:2, fee:20000, paid:20000, status:"Paid",    phone:"0756789012", parent:"Samuel Njeri"   },
  { id: 6, adm:"ADM-1201", name:"Faith Wambui",     cls:"Form 1C", form:1, fee:18000, paid:6000,  status:"Partial", phone:"0767890123", parent:"Mary Wambui"   },
  { id: 7, adm:"ADM-0612", name:"George Mutua",     cls:"Form 4B", form:4, fee:24000, paid:24000, status:"Paid",    phone:"0778901234", parent:"Alice Mutua"   },
  { id: 8, adm:"ADM-0987", name:"Grace Achieng",    cls:"Form 3B", form:3, fee:22000, paid:6000,  status:"Unpaid",  phone:"0789012345", parent:"Peter Achieng" },
];

export const useStore = create((set) => ({
  students: INITIAL_STUDENTS,

  addStudent: (student) => set((state) => ({
    students: [{ ...student, id: Date.now() }, ...state.students]
  })),
}));
