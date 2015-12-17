import {createValidator, required, integer} from 'utils/validation';

const sendValidation = createValidator({
  recipient: [required],
  amount: [required, integer]
});
export default sendValidation;